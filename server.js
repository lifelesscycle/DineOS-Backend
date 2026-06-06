/**
 * server.js
 *
 * Entry point for the DineOS backend.
 */

'use strict';

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const http     = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);

// ── CORS ────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:3000']; // Vite + CRA dev defaults

const corsOptions = {
  origin(origin, cb) {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

// ── Socket.IO ───────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: corsOptions,
  // Reduce overhead — disable polling fallback if clients are modern
  transports: ['websocket', 'polling'],
  pingTimeout: 60000, // Detect dead connections faster
  pingInterval: 25000,
});

// ── Middleware ──────────────────────────────────────────────────────────
app.set('trust proxy', 1); // Required when behind Nginx / load-balancer

app.use(helmet());          // Sets secure HTTP headers
app.use(cors(corsOptions));
app.use(express.json()); // Reject oversized payloads

// Attach Socket.IO instance to every request so route handlers can emit
app.use((req, _res, next) => {
  req.io = io;
  next();
});

// ── Routes ──────────────────────────────────────────────────────────────
const apiRouter = require('./routes/api');
app.use('/api', apiRouter);

const restaurantRouter = require('./routes/restaurant');
app.use('/api/restaurant', restaurantRouter);

const tablesRouter = require('./routes/tables');
app.use('/api/tables', tablesRouter);

const syncRouter = require('./routes/sync');
app.use('/api/sync', syncRouter);


// ── Centralised error handler ───────────────────────────────────────────
// Must have 4 parameters so Express recognises it as an error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status  = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : 'Internal server error';

  if (status >= 500) {
    console.error('[ERROR]', err);
  }

  res.status(status).json({ error: message });
});

// ── Socket.IO events ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[WS] connected   ${socket.id}`);
  }

  socket.on('join_room', (room) => {
    if (typeof room !== 'string' || room.length > 64) return; // basic guard
    socket.join(room);
  });

  socket.on('disconnect', () => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[WS] disconnected ${socket.id}`);
    }
  });
});

// ── Graceful shutdown ───────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[SERVER] ${signal} received — shutting down gracefully`);

  server.close(() => {
    console.log('[SERVER] HTTP server closed');
    // db.close() is called via process.on('exit') registered in db.js
    process.exit(0);
  });

  // Force-exit if shutdown takes longer than 10 s
  setTimeout(() => {
    console.error('[SERVER] Forced exit after timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
  shutdown('uncaughtException');
});

// ── Start ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '4000', 10);

server.listen(PORT, () => {
  console.log(`[SERVER] DineOS running on http://localhost:${PORT}`);
  console.log(`[SERVER] env=${process.env.NODE_ENV || 'development'}`);
});