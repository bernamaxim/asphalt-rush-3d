const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000
});

app.use(express.json({ limit: '1mb' }));

// FIREBASE
// Firebase failure must not crash multiplayer.
let db = null;
let newsRef = null;

try {
  const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!rawServiceAccount || !rawServiceAccount.trim()) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT belum disetel atau kosong.');
  }

  let serviceAccount;
  const credentialText = rawServiceAccount.trim();

  try {
    serviceAccount = JSON.parse(credentialText);
  } catch (jsonError) {
    try {
      serviceAccount = JSON.parse(
        Buffer.from(credentialText, 'base64').toString('utf8')
      );
    } catch (_) {
      throw new Error(
        'FIREBASE_SERVICE_ACCOUNT bukan JSON valid atau Base64 JSON valid: ' +
        jsonError.message
      );
    }
  }

  if (typeof serviceAccount.private_key === 'string') {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, '\n');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  db = admin.firestore();
  newsRef = db.collection('gameContent').doc('news');

  console.log('Firebase Admin initialized successfully.');

} catch (error) {
  console.error('FIREBASE INITIALIZATION ERROR:', error.message);
  console.error('Multiplayer tetap dijalankan; API berita sementara tidak tersedia.');
}

function requireFirebase(res) {
  if (!newsRef) {
    res.status(503).json({
      error: 'Layanan berita sementara tidak tersedia. Periksa FIREBASE_SERVICE_ACCOUNT di Heroku.'
    });
    return false;
  }
  return true;
}

async function getNews() {
  const doc = await newsRef.get();

  if (doc.exists) {
    return doc.data();
  }

  const oldFile = path.join(__dirname, 'news.json');
  let initial = { version: '1.0.0', items: [] };

  if (fs.existsSync(oldFile)) {
    const oldData = JSON.parse(fs.readFileSync(oldFile, 'utf8'));

    initial = {
      version: oldData.version || '1.0.0',
      items: Array.isArray(oldData.items)
        ? oldData.items
        : Array.isArray(oldData) ? oldData : []
    };
  }

  await newsRef.set({
    ...initial,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return initial;
}

// AUTH ADMIN
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';

  if (!header.startsWith('Basic ')) {
    return res.status(401).json({
      error: 'Login admin diperlukan.'
    });
  }

  let decoded;

  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch (e) {
    return res.status(401).json({
      error: 'Login tidak valid.'
    });
  }

  const separator = decoded.indexOf(':');
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);

  if (
    separator < 0 ||
    username !== process.env.ADMIN_USER ||
    password !== process.env.ADMIN_PASSWORD
  ) {
    return res.status(401).json({
      error: 'Username atau password salah.'
    });
  }

  next();
}

// API NEWS
app.get('/api/news', async (req, res) => {
  if (!requireFirebase(res)) return;

  try {
    const news = await getNews();

    res.set('Cache-Control', 'no-store');

    res.json({
      version: news.version || '1.0.0',
      items: news.items || []
    });

  } catch (error) {
    console.error('GET NEWS ERROR:', error);
    res.status(500).json({
      error: 'Gagal mengambil berita.'
    });
  }
});

// API SAVE NEWS
app.put('/api/admin/news', requireAdmin, async (req, res) => {
  if (!requireFirebase(res)) return;

  try {
    const version = String(req.body.version || '1.0.0').slice(0, 30);
    const items = req.body.items;

    if (!Array.isArray(items)) {
      return res.status(400).json({
        error: 'Format berita tidak valid.'
      });
    }

    if (items.length > 200) {
      return res.status(400).json({
        error: 'Maksimal 200 berita.'
      });
    }

    await newsRef.set({
      version,
      items,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      news: { version, items }
    });

  } catch (error) {
    console.error('SAVE NEWS ERROR:', error);

    res.status(500).json({
      error: 'Gagal menyimpan berita ke Firebase.'
    });
  }
});

// MULTIPLAYER
const rooms = new Map();
const MAX_PLAYERS = 8;

const code = () =>
  Math.random().toString(36).slice(2, 7).toUpperCase();

function snapshot(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    map: room.map,
    difficulty: room.difficulty,
    players: Object.fromEntries(
      [...room.players].map(([id, p]) => [id, { ...p, id }])
    )
  };
}

function publish(room) {
  io.to(room.code).emit('room-state', snapshot(room));
}

function leave(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;

  const room = rooms.get(roomCode);

  socket.leave(roomCode);
  socket.data.roomCode = null;

  if (!room) return;

  room.players.delete(socket.id);

  if (!room.players.size) {
    rooms.delete(roomCode);
    return;
  }

  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }

  io.to(roomCode).emit('player-left', {
    id: socket.id
  });

  publish(room);
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) =>
  res.json({
    ok: true,
    rooms: rooms.size
  })
);

io.on('connection', socket => {

  socket.on('create-room', data => {
    leave(socket);

    let roomCode;

    do {
      roomCode = code();
    } while (rooms.has(roomCode));

    const room = {
      code: roomCode,
      hostId: socket.id,
      started: false,

      map: ['city', 'desert', 'coast'].includes(data?.map)
        ? data.map : 'city',

      difficulty: ['easy', 'normal', 'hard', 'extreme'].includes(data?.difficulty)
        ? data.difficulty : 'normal',

      players: new Map()
    };

    room.players.set(socket.id, {
      name: String(data?.name || 'Racer').slice(0, 16),
      distance: 0,
      speed: 0,
      lane: 0,
      color: 0xff3030
    });

    rooms.set(roomCode, room);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    publish(room);
  });

  socket.on('join-room', data => {
    const roomCode = String(data?.code || '')
      .toUpperCase().replace(/[^A-Z0-9]/g, '');

    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('room-error', {
        message: 'Kode room tidak ditemukan.'
      });
      return;
    }

    if (room.started) {
      socket.emit('room-error', {
        message: 'Balapan di room ini sudah dimulai.'
      });
      return;
    }

    if (room.players.size >= MAX_PLAYERS) {
      socket.emit('room-error', {
        message: 'Room sudah penuh (maksimal 8 pemain).'
      });
      return;
    }

    leave(socket);

    room.players.set(socket.id, {
      name: String(data?.name || 'Racer').slice(0, 16),
      distance: 0,
      speed: 0,
      lane: 0,
      color: 0x00bfff
    });

    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    publish(room);
  });

  socket.on('quick-match', data => {
    let room = [...rooms.values()].find(r =>
      !r.started &&
      r.players.size < MAX_PLAYERS &&
      r.map === (data?.map || 'city') &&
      r.difficulty === (data?.difficulty || 'normal')
    );

    if (!room) {
      socket.emit('room-error', {
        message: 'Belum ada room publik. Buat room dan bagikan kodenya.'
      });
      return;
    }

    leave(socket);

    room.players.set(socket.id, {
      name: String(data?.name || 'Racer').slice(0, 16),
      distance: 0,
      speed: 0,
      lane: 0,
      color: 0x00bfff
    });

    socket.join(room.code);
    socket.data.roomCode = room.code;

    publish(room);
  });

  socket.on('start-race', data => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || room.hostId !== socket.id || room.started) return;

    room.map = ['city', 'desert', 'coast'].includes(data?.map)
      ? data.map : room.map;

    room.difficulty = ['easy', 'normal', 'hard', 'extreme'].includes(data?.difficulty)
      ? data.difficulty : room.difficulty;

    room.started = true;

    io.to(room.code).emit('race-start', {
      map: room.map,
      difficulty: room.difficulty
    });

    publish(room);
  });

  socket.on('player-update', data => {
    const room = rooms.get(socket.data.roomCode);

    if (!room || !room.started) return;

    const p = room.players.get(socket.id);

    if (!p) return;

    p.distance = Math.max(
      0,
      Math.min(1500, Number(data?.distance) || 0)
    );

    p.speed = Math.max(
      0,
      Math.min(500, Number(data?.speed) || 0)
    );

    p.lane = Math.max(
      -1,
      Math.min(1, Number(data?.lane) || 0)
    );

    p.color = Number(data?.color) || p.color;
    p.finished = !!data?.finished;

    socket.to(room.code).volatile.emit('player-update', {
      ...p,
      id: socket.id
    });
  });

  socket.on('player-finished', data => {
    const room = rooms.get(socket.data.roomCode);

    if (room) {
      socket.to(room.code).emit('player-finished', {
        id: socket.id,
        score: Number(data?.score) || 0
      });
    }
  });

  socket.on('leave-room', () => leave(socket));
  socket.on('disconnect', () => leave(socket));

});

// START SERVER
const port = process.env.PORT || 3000;

server.listen(port, '0.0.0.0', () => {
  console.log(
    `Asphalt Rush 3D multiplayer server listening on ${port}`
  );
});
