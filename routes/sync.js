const express = require('express');
const router = express.Router();
const db = require('../data/db');

// React calls this to queue an operation locally
router.post('/queue', (req, res) => {
  const { id, operation, payload } = req.body;
  db.prepare(`
    INSERT OR IGNORE INTO sync_queue (id, operation, payload)
    VALUES (?, ?, ?)
  `).run(id, operation, JSON.stringify(payload));
  res.json({ ok: true });
});

// React fetches unsynced ops before attempting cloud push
router.get('/queue/pending', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM sync_queue WHERE synced = 0 ORDER BY created_at ASC'
  ).all();
  res.json(rows.map(r => ({ ...r, payload: JSON.parse(r.payload) })));
});

// After cloud confirms, mark as synced
router.post('/queue/mark-synced', (req, res) => {
  const { ids } = req.body;
  const stmt = db.prepare('UPDATE sync_queue SET synced = 1 WHERE id = ?');
  ids.forEach(id => stmt.run(id));
  res.json({ ok: true });
});

// SSE — cashier listens for incoming QR orders
const clients = new Set();
router.get('/orders/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Call this from your order creation logic to push to cashier screen
router.broadcastOrder = (order) => {
  clients.forEach(res =>
    res.write(`data: ${JSON.stringify(order)}\n\n`)
  );
};

module.exports = router;