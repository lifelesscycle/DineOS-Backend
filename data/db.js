/**
 * db.js
 *
 * Opens (or creates) the SQLite database, applies pragmas for performance
 * and safety, and runs schema migrations.  No seed data — all tables start
 * empty so the operator can configure the system through the frontend.
 *
 * The only rows written on first boot are the bare-minimum restaurant
 * settings keys (with empty values) so the Settings page never 404s on
 * a missing row.
 */

'use strict';

const Database = require('better-sqlite3');
const path     = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'dineos.db');

const db = new Database(DB_PATH, {
  // never log SQL in production — queries can contain sensitive data
  verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
});

// ── Pragmas ─────────────────────────────────────────────────────────────
db.pragma('journal_mode = WAL');      // concurrent reads while writing
db.pragma('foreign_keys = ON');       // enforce FK constraints
db.pragma('synchronous = NORMAL');    // safe with WAL, faster than FULL
db.pragma('temp_store = MEMORY');     // keep temp tables in RAM
db.pragma('mmap_size = 134217728');   // 128 MB memory-mapped I/O
db.pragma('cache_size = -16000');     // 16 MB page cache (negative = KiB)
db.pragma('busy_timeout = 5000');     // wait up to 5 s on a locked DB

// ── Schema ──────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS restaurant (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS menu (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT    NOT NULL,
    cat       TEXT    NOT NULL DEFAULT 'Others',
    price     REAL    NOT NULL,
    cost      REAL    NOT NULL DEFAULT 0,
    prep      INTEGER NOT NULL DEFAULT 0,
    available INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS tables (
    id           INTEGER PRIMARY KEY,
    seats        INTEGER NOT NULL DEFAULT 4,
    status       TEXT    NOT NULL DEFAULT 'empty',
    order_id     TEXT,
    open_time    TEXT,
    reserved_for TEXT
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            TEXT PRIMARY KEY,
    table_id      INTEGER,
    type          TEXT NOT NULL DEFAULT 'dine-in',
    customer_name TEXT,
    note          TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'pending',
    pay_status    TEXT NOT NULL DEFAULT 'unpaid',
    pay_method    TEXT,
    subtotal      REAL NOT NULL DEFAULT 0,
    discount      REAL NOT NULL DEFAULT 0,
    discount_amt  REAL NOT NULL DEFAULT 0,
    tax           REAL NOT NULL DEFAULT 0,
    total         REAL NOT NULL DEFAULT 0,
    source        TEXT NOT NULL DEFAULT 'pos',
    time_str      TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT,
    paid_at       TEXT
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_id  INTEGER NOT NULL,
    name     TEXT    NOT NULL,
    cat      TEXT    NOT NULL,
    price    REAL    NOT NULL,
    cost     REAL    NOT NULL DEFAULT 0,
    prep     INTEGER NOT NULL DEFAULT 0,
    qty      INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS inventory (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL,
    unit      TEXT NOT NULL DEFAULT 'kg',
    stock     REAL NOT NULL DEFAULT 0,
    min_stock REAL NOT NULL DEFAULT 0,
    cost      REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS staff (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    name   TEXT    NOT NULL,
    role   TEXT    NOT NULL DEFAULT 'waiter',
    pin    TEXT    NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id          TEXT PRIMARY KEY,
    order_id    TEXT NOT NULL REFERENCES orders(id),
    amount      REAL NOT NULL,
    method      TEXT NOT NULL,
    amount_paid REAL NOT NULL,
    change      REAL NOT NULL DEFAULT 0,
    paid_at     TEXT NOT NULL
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
  CREATE INDEX IF NOT EXISTS idx_orders_pay_status ON orders(pay_status);
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
  CREATE INDEX IF NOT EXISTS idx_tables_status     ON tables(status);
`);

// Add to your existing db setup
db.exec(`
  CREATE TABLE IF NOT EXISTS sync_queue (
    id          TEXT PRIMARY KEY,
    operation   TEXT NOT NULL,
    payload     TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    synced      INTEGER DEFAULT 0
  );
`);

// ── Bootstrap restaurant settings (keys only, empty values) ─────────────
// Ensures the Settings API never returns 404 on first launch.
// The operator fills in real values through the frontend.
const bootstrapSettings = db.transaction(() => {
  // Use INSERT OR IGNORE so re-runs on existing DBs are no-ops.
  // The key set here must be a superset of ALLOWED_KEYS in routes/restaurant.js.
  const ins = db.prepare('INSERT OR IGNORE INTO restaurant (key, value) VALUES (?, ?)');

  const defaults = {
    // Restaurant info
    name:          '',
    address:       '',
    phone:         '',
    gstNo:         '',   // was incorrectly seeded as 'gst' before — keep both for safety
    upi:           '',
    // Billing
    currency:      '₹',
    taxRate:       '5',
    tableCount:    '16',
    serviceCharge: '0',
    // Feature flags (stored as the string 'true'/'false')
    qrOrdering:    'true',
    kds:           'true',
    discounts:     'true',
    gst:           'true',
    multiTable:    'true',
  };

  for (const [key, value] of Object.entries(defaults)) {
    ins.run(key, value);
  }
});

bootstrapSettings();

// ── Sync tables rows to match tableCount setting ──────────────────────────
// Called on boot and whenever tableCount changes via PUT /api/restaurant.
function syncTables(count) {
  const n = parseInt(count, 10) || 16;
  const syncTx = db.transaction((n) => {
    const existing = db.prepare('SELECT id FROM tables').all().map(r => r.id);
    const max = existing.length ? Math.max(...existing) : 0;

    // Add missing rows
    const ins = db.prepare(
      "INSERT OR IGNORE INTO tables (id, seats, status) VALUES (?, 4, 'empty')"
    );
    for (let i = 1; i <= n; i++) ins.run(i);

    // Remove excess rows (only empty/reserved ones — never remove occupied tables)
    if (max > n) {
      db.prepare(`
        DELETE FROM tables
        WHERE id > ?
          AND status IN ('empty', 'reserved')
          AND order_id IS NULL
      `).run(n);
    }
  });
  syncTx(n);
}

// Run on every boot so the table grid always matches the saved tableCount
const savedCount = db.prepare("SELECT value FROM restaurant WHERE key = 'tableCount'").get();
syncTables(savedCount?.value ?? 16);

module.exports = { db, syncTables };  

// ── Graceful shutdown ────────────────────────────────────────────────────
process.on('exit', () => {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (_) { /* already closed or never opened */ }
});

