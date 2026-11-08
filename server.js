const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000
});

const rooms = new Map();
const MAX_PLAYERS = 8;
const code = () => Math.random().toString(36).slice(2, 7).toUpperCase();

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

  io.to(roomCode).emit('player-left', { id: socket.id });
  publish(room);
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) =>
  res.json({ ok: true, rooms: rooms.size })
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

    p.distance = Math.max(0, Math.min(1500, Number(data?.distance) || 0));
    p.speed = Math.max(0, Math.min(500, Number(data?.speed) || 0));
    p.lane = Math.max(-1, Math.min(1, Number(data?.lane) || 0));
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
app.use(express.json({ limit: '1mb' }));

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(
    `${process.env.ADMIN_USER || 'admin'}:${process.env.ADMIN_PASSWORD || ''}`
  ).toString('base64');

  if (!process.env.ADMIN_PASSWORD || auth !== expected) {
    res.set('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Unauthorized');
  }

  next();
}

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/news', (req, res) => {
  try {
    const news = JSON.parse(
      fs.readFileSync(path.join(__dirname, 'news.json'), 'utf8')
    );
    res.json(news);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load news' });
  }
});

app.put('/api/admin/news', requireAdmin, (req, res) => {
  try {
    fs.writeFileSync(
      path.join(__dirname, 'news.json'),
      JSON.stringify(req.body, null, 2)
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save news' });
  }
});

const port = process.env.PORT || 3000;

server.listen(port, '0.0.0.0', () => {
  console.log(`Asphalt Rush 3D multiplayer server listening on ${port}`);
});
