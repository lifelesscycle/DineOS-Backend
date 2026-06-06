'use strict';

const express            = require('express');
const router             = express.Router();
const { db, syncTables } = require('../data/store');  // ← single source of truth

function readSettings() {
  const rows = db.prepare('SELECT key, value FROM restaurant').all();
  const out  = {};
  for (const { key, value } of rows) {
    if (value === '')   { out[key] = '';    continue; }
    if (value === 'true')  { out[key] = true;  continue; }
    if (value === 'false') { out[key] = false; continue; }
    if (!isNaN(value) && value !== '') { out[key] = Number(value); continue; }
    out[key] = value;
  }
  return out;
}

// GET /api/restaurant
router.get('/', (req, res, next) => {
  try {
    res.json(readSettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/restaurant
router.put('/', (req, res, next) => {
  try {
    const body = req.body || {};

    const ALLOWED_KEYS = [
      'name', 'address', 'phone', 'gstNo', 'upi',
      'currency', 'taxRate', 'tableCount', 'serviceCharge',
      'qrOrdering', 'kds', 'discounts', 'gst', 'multiTable',
    ];

    const upsert = db.prepare(`
      INSERT INTO restaurant (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);

    db.transaction(() => {
      for (const key of ALLOWED_KEYS) {
        if (key in body) upsert.run(key, String(body[key]));
      }
    })();

    let tableSync = null;
    if ('tableCount' in body) {
      const count = parseInt(body.tableCount, 10);
      if (!isNaN(count) && count > 0) {
        tableSync = syncTables(count);
        if (req.io) {
          req.io.emit('tables_updated', { tableCount: count, ...tableSync });
        }
      }
    }

    res.json({
      ok: true,
      settings: readSettings(),
      ...(tableSync && { tableSync }),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;