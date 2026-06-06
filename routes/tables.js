/**
 * routes/tables.js
 *
 * GET  /api/tables              — all tables as JSON array
 * GET  /api/tables/:id          — single table
 * PUT  /api/tables/:id          — update arbitrary fields (seats, status, etc.)
 * POST /api/tables/:id/reserve  — mark reserved_for = name
 * POST /api/tables/:id/clear    — reset to empty
 */

'use strict';

const express = require('express');
const router  = express.Router();
const { db }  = require('../data/store');   // adjust path if needed

// ── Helpers ──────────────────────────────────────────────────────────────

/** Map a DB row (snake_case) → camelCase object the frontend expects. */
function rowToTable(row) {
  if (!row) return null;
  return {
    id:          row.id,
    seats:       row.seats,
    status:      row.status,
    orderId:     row.order_id     ?? null,
    openTime:    row.open_time    ?? null,
    reservedFor: row.reserved_for ?? null,
  };
}

// ── GET /api/tables ──────────────────────────────────────────────────────
router.get('/', (req, res, next) => {
  try {
    const rows = db.prepare('SELECT * FROM tables ORDER BY id').all();
    res.json(rows.map(rowToTable));
  } catch (err) {
    next(err);
  }
});

// ── GET /api/tables/:id ──────────────────────────────────────────────────
router.get('/:id', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Table not found' });
    res.json(rowToTable(row));
  } catch (err) {
    next(err);
  }
});

// ── PUT /api/tables/:id ──────────────────────────────────────────────────
router.put('/:id', (req, res, next) => {
  try {
    const { seats, status, orderId, openTime, reservedFor } = req.body || {};

    db.prepare(`
      UPDATE tables SET
        seats        = COALESCE(?, seats),
        status       = COALESCE(?, status),
        order_id     = COALESCE(?, order_id),
        open_time    = COALESCE(?, open_time),
        reserved_for = COALESCE(?, reserved_for)
      WHERE id = ?
    `).run(
      seats       ?? null,
      status      ?? null,
      orderId     ?? null,
      openTime    ?? null,
      reservedFor ?? null,
      req.params.id,
    );

    const updated = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    if (!updated) return res.status(404).json({ error: 'Table not found' });

    const table = rowToTable(updated);
    if (req.io) req.io.emit('table_updated', table);
    res.json(table);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tables/:id/reserve ─────────────────────────────────────────
router.post('/:id/reserve', (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const row = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Table not found' });
    if (row.status === 'occupied') {
      return res.status(409).json({ error: 'Table is currently occupied' });
    }

    db.prepare(`
      UPDATE tables SET status = 'reserved', reserved_for = ? WHERE id = ?
    `).run(name.trim(), req.params.id);

    const updated = rowToTable(db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id));
    if (req.io) req.io.emit('table_updated', updated);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/tables/:id/clear ───────────────────────────────────────────
router.post('/:id/clear', (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Table not found' });

    db.prepare(`
      UPDATE tables
      SET status = 'empty', order_id = NULL, open_time = NULL, reserved_for = NULL
      WHERE id = ?
    `).run(req.params.id);

    const updated = rowToTable(db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id));
    if (req.io) req.io.emit('table_updated', updated);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

module.exports = router;