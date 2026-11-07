ASPHALT RUSH 3D — MULTIPLAYER STARTER

Isi ZIP:
- public/index.html: game + menu multiplayer (single HTML Three.js)
- server.js: room server Socket.IO

MENJALANKAN DI KOMPUTER / VPS
1. Install Node.js 18 atau lebih baru.
2. Ekstrak ZIP. Buka terminal di folder Asphalt_Rush_3D_Multiplayer.
3. Jalankan: npm install
4. Jalankan: npm start
5. Buka http://localhost:3000

MABAR DI JARINGAN YANG SAMA
- Pastikan perangkat berada di Wi-Fi yang sama.
- Jalankan server pada komputer yang menjadi host.
- Teman membuka http://IP-LOKAL-KOMPUTER:3000 (contoh http://192.168.1.10:3000).
- Buat Room, bagikan kode 5 karakter, teman pilih Gabung. Host tekan Mulai Balapan Online.

MABAR VIA INTERNET
- Deploy folder ini ke VPS / layanan Node.js yang mendukung WebSocket dan set PORT.
- Buka URL publik HTTPS hasil deployment pada semua perangkat.
- Jangan membuka file HTML langsung dari file:// atau content://; Socket.IO perlu origin HTTP/HTTPS.

CATATAN PROTOTIPE
- Mendukung room privat dan quick match ke room yang sudah dibuat (maksimal 8 pemain).
- Posisi pemain dikirim real-time dan ditampilkan sebagai mobil lawan.
- Ini prototipe multiplayer awal: belum ada akun, matchmaking publik lintas region, anti-cheat penuh, sinkronisasi tabrakan, atau server-authoritative physics. Untuk internet publik, gunakan HTTPS dan tambahkan validasi/anti-cheat sebelum rilis.
