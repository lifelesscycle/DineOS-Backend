'use strict';

const { db } = require('./db');

let _orderNum = null;

function _loadNextOrderNum() {
  const row = db.prepare("SELECT id FROM orders ORDER BY id DESC LIMIT 1").get();
  if (!row) return 1;
  const match = row.id.match(/ORD-(\d+)/);
  return match ? parseInt(match[1], 10) + 1 : 1;
}

function getOrderId() {
  if (_orderNum === null) _orderNum = _loadNextOrderNum();
  return `ORD-${String(_orderNum++).padStart(4, '0')}`;
}

function now() {
  return new Date().toISOString();
}

function timeStr() {
  return new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Ensure the `tables` table contains exactly `count` rows.
 * - Adds missing rows (status = 'empty')
 * - Removes surplus rows only if they are empty (never occupied/reserved)
 * Returns { added, removed }
 */
function syncTables(count) {
  count = Math.max(1, Math.min(200, parseInt(count, 10) || 16));

  const existing = db.prepare('SELECT id FROM tables ORDER BY id').all().map(r => r.id);
  const maxId    = existing.length ? Math.max(...existing) : 0;

  let added   = 0;
  let removed = 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO tables (id, seats, status)
    VALUES (?, ?, 'empty')
  `);

  const deleteSafe = db.prepare(`
    DELETE FROM tables WHERE id = ? AND status = 'empty' AND order_id IS NULL
  `);

  db.transaction(() => {
    for (let i = 1; i <= count; i++) {
      if (!existing.includes(i)) {
        const seats = i <= Math.ceil(count / 2) ? 4 : 6;
        insert.run(i, seats);
        added++;
      }
    }
    for (let i = count + 1; i <= maxId; i++) {
      const result = deleteSafe.run(i);
      removed += result.changes;
    }
  })();

  return { added, removed };
}

// Sync on every server boot so the floor plan always matches the saved tableCount
const _savedCount = db.prepare("SELECT value FROM restaurant WHERE key = 'tableCount'").get();
syncTables(_savedCount?.value ?? 16);

module.exports = { db, getOrderId, now, timeStr, syncTables };