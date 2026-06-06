const express = require('express');
const router = express.Router();
const { db, getOrderId, now, timeStr } = require('../data/store');

// ── Helpers ─────────────────────────────────────────────────────────────
function getRestaurant() {
  const rows = db.prepare('SELECT key, value FROM restaurant').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function rowToOrder(row) {
  if (!row) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(row.id);
  return {
    id:           row.id,
    tableId:      row.table_id,
    type:         row.type,
    customerName: row.customer_name,
    note:         row.note,
    status:       row.status,
    payStatus:    row.pay_status,
    payMethod:    row.pay_method,
    subtotal:     row.subtotal,
    discount:     row.discount,
    discountAmt:  row.discount_amt,
    tax:          row.tax,
    total:        row.total,
    source:       row.source,
    timeStr:      row.time_str,
    createdAt:    row.created_at,
    updatedAt:    row.updated_at,
    paidAt:       row.paid_at,
    items:        items.map(i => ({
      id:    i.menu_id,
      name:  i.name,
      cat:   i.cat,
      price: i.price,
      cost:  i.cost,
      prep:  i.prep,
      qty:   i.qty,
    })),
  };
}

function rowToTable(row) {
  return {
    id:          row.id,
    seats:       row.seats,
    status:      row.status,
    orderId:     row.order_id,
    openTime:    row.open_time,
    reservedFor: row.reserved_for,
  };
}

function getAllTables() {
  return db.prepare('SELECT * FROM tables ORDER BY id').all().map(rowToTable);
}

// ── RESTAURANT ──────────────────────────────────────────────────────────
router.get('/restaurant', (req, res) => {
  res.json(getRestaurant());
});

router.put('/restaurant', (req, res) => {
  const upd = db.prepare('INSERT OR REPLACE INTO restaurant (key, value) VALUES (?, ?)');
  const run = db.transaction((body) => {
    for (const [key, value] of Object.entries(body)) upd.run(key, String(value));
  });
  run(req.body);
  res.json(getRestaurant());
});

// ── MENU ────────────────────────────────────────────────────────────────
router.get('/menu', (req, res) => {
  res.json(db.prepare('SELECT * FROM menu ORDER BY id').all().map(m => ({
    ...m, available: m.available === 1,
  })));
});

router.get('/menu/available', (req, res) => {
  res.json(db.prepare('SELECT * FROM menu WHERE available = 1 ORDER BY id').all().map(m => ({
    ...m, available: true,
  })));
});

router.post('/menu', (req, res) => {
  const { name, cat, price, cost, prep, available } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Item name is required' });
  if (!price || +price <= 0)  return res.status(400).json({ error: 'Valid price is required' });

  const result = db.prepare(
    'INSERT INTO menu (name, cat, price, cost, prep, available) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    name.trim(),
    cat || 'Others',
    +price,
    cost ? +cost : 0,
    prep ? +prep : 0,
    available !== false ? 1 : 0
  );
  const item = db.prepare('SELECT * FROM menu WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json({ ...item, available: item.available === 1 });
});

router.put('/menu/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM menu WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const { id: _drop, ...rest } = req.body;
  db.prepare(`
    UPDATE menu SET
      name      = ?,
      cat       = ?,
      price     = ?,
      cost      = ?,
      prep      = ?,
      available = ?
    WHERE id = ?
  `).run(
    rest.name      !== undefined ? rest.name.trim()      : item.name,
    rest.cat       !== undefined ? rest.cat              : item.cat,
    rest.price     !== undefined ? +rest.price           : item.price,
    rest.cost      !== undefined ? +rest.cost            : item.cost,
    rest.prep      !== undefined ? +rest.prep            : item.prep,
    rest.available !== undefined ? (rest.available ? 1 : 0) : item.available,
    item.id
  );
  const updated = db.prepare('SELECT * FROM menu WHERE id = ?').get(item.id);
  res.json({ ...updated, available: updated.available === 1 });
});

router.delete('/menu/:id', (req, res) => {
  db.prepare('DELETE FROM menu WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── TABLES ──────────────────────────────────────────────────────────────
router.get('/tables', (req, res) => {
  res.json(getAllTables());
});

router.get('/tables/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Table not found' });
  res.json(rowToTable(row));
});

router.put('/tables/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Table not found' });

  const { status, order_id, open_time, reserved_for } = { ...row, ...req.body };
  db.prepare(`
    UPDATE tables SET status = ?, order_id = ?, open_time = ?, reserved_for = ? WHERE id = ?
  `).run(status, order_id ?? null, open_time ?? null, reserved_for ?? null, row.id);

  const updated = db.prepare('SELECT * FROM tables WHERE id = ?').get(row.id);
  req.io?.emit('tables_updated', getAllTables());
  res.json(rowToTable(updated));
});

router.post('/tables/:id/reserve', (req, res) => {
  const row = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Table not found' });
  if (row.status !== 'empty') return res.status(400).json({ error: 'Table not available' });

  db.prepare("UPDATE tables SET status = 'reserved', reserved_for = ? WHERE id = ?")
    .run(req.body.name || 'Guest', row.id);

  const updated = db.prepare('SELECT * FROM tables WHERE id = ?').get(row.id);
  req.io?.emit('tables_updated', getAllTables());
  res.json(rowToTable(updated));
});

router.post('/tables/:id/clear', (req, res) => {
  const row = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Table not found' });

  db.prepare(`
    UPDATE tables SET status = 'empty', order_id = NULL, open_time = NULL, reserved_for = NULL
    WHERE id = ?
  `).run(row.id);

  const updated = db.prepare('SELECT * FROM tables WHERE id = ?').get(row.id);
  req.io?.emit('tables_updated', getAllTables());
  res.json(rowToTable(updated));
});

// ── ORDERS ──────────────────────────────────────────────────────────────
router.get('/orders', (req, res) => {
  let sql = 'SELECT * FROM orders WHERE 1=1';
  const params = [];
  if (req.query.status)    { sql += ' AND status = ?';     params.push(req.query.status); }
  if (req.query.payStatus) { sql += ' AND pay_status = ?'; params.push(req.query.payStatus); }
  if (req.query.table)     { sql += ' AND table_id = ?';   params.push(req.query.table); }
  sql += ' ORDER BY created_at DESC';

  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(rowToOrder));
});

router.get('/orders/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found' });
  res.json(rowToOrder(row));
});

router.post('/orders', (req, res) => {
  const { tableId, items, note, type = 'dine-in', customerName } = req.body;
  if (!items || !items.length) return res.status(400).json({ error: 'No items in order' });

  // Resolve menu items
  const resolvedItems = [];
  for (const item of items) {
    const menuItem = db.prepare('SELECT * FROM menu WHERE id = ? AND available = 1').get(item.id);
    if (!menuItem) return res.status(400).json({ error: `Item "${item.id}" not found or unavailable` });
    resolvedItems.push({ ...menuItem, qty: Math.max(1, parseInt(item.qty) || 1) });
  }

  const restaurant = getRestaurant();
  const taxRate    = parseFloat(restaurant.taxRate) || 5;
  const orderId    = getOrderId();
  const subtotal   = resolvedItems.reduce((s, i) => s + i.price * i.qty, 0);
  const tax        = Math.round(subtotal * taxRate / 100);
  const total      = subtotal + tax;
  const createdAt  = now();
  const ts         = timeStr();

  const createOrder = db.transaction(() => {
    db.prepare(`
      INSERT INTO orders
        (id, table_id, type, customer_name, note, status, pay_status, subtotal, tax, total, source, time_str, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 'unpaid', ?, ?, ?, ?, ?, ?)
    `).run(orderId, tableId || null, type, customerName || null, note || '', subtotal, tax, total,
           req.body.source || 'pos', ts, createdAt);

    const insItem = db.prepare(`
      INSERT INTO order_items (order_id, menu_id, name, cat, price, cost, prep, qty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const i of resolvedItems) {
      insItem.run(orderId, i.id, i.name, i.cat, i.price, i.cost, i.prep, i.qty);
    }

    if (tableId) {
      db.prepare(`
        UPDATE tables SET status = 'occupied', order_id = ?, open_time = ? WHERE id = ?
      `).run(orderId, ts, tableId);
    }
  });

  createOrder();

  const order = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId));
  req.io?.emit('new_order', order);
  req.io?.emit('tables_updated', getAllTables());
  res.json(order);
});

router.put('/orders/:id/status', (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found' });

  db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?')
    .run(req.body.status, now(), req.params.id);

  const order = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
  req.io?.emit('order_updated', order);
  res.json(order);
});

router.post('/orders/:id/items', (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found' });

  const addItems = db.transaction(() => {
    for (const item of req.body.items || []) {
      const menuItem = db.prepare('SELECT * FROM menu WHERE id = ? AND available = 1').get(item.id);
      if (!menuItem) continue;
      const qty = Math.max(1, parseInt(item.qty) || 1);

      const existing = db.prepare('SELECT * FROM order_items WHERE order_id = ? AND menu_id = ?')
        .get(req.params.id, item.id);
      if (existing) {
        db.prepare('UPDATE order_items SET qty = qty + ? WHERE id = ?').run(qty, existing.id);
      } else {
        db.prepare(`
          INSERT INTO order_items (order_id, menu_id, name, cat, price, cost, prep, qty)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(req.params.id, menuItem.id, menuItem.name, menuItem.cat,
               menuItem.price, menuItem.cost, menuItem.prep, qty);
      }
    }

    // Recalculate
    const restaurant = getRestaurant();
    const taxRate    = parseFloat(restaurant.taxRate) || 5;
    const items      = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(req.params.id);
    const subtotal   = items.reduce((s, i) => s + i.price * i.qty, 0);
    const discountAmt = Math.round(subtotal * row.discount / 100);
    const tax        = Math.round((subtotal - discountAmt) * taxRate / 100);
    const total      = subtotal - discountAmt + tax;

    db.prepare(`
      UPDATE orders SET subtotal = ?, discount_amt = ?, tax = ?, total = ?, status = 'pending', updated_at = ?
      WHERE id = ?
    `).run(subtotal, discountAmt, tax, total, now(), req.params.id);
  });

  addItems();

  const order = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
  req.io?.emit('order_updated', order);
  res.json(order);
});

// ── BILLING ─────────────────────────────────────────────────────────────
router.post('/orders/:id/bill', (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found' });

  const restaurant  = getRestaurant();
  const taxRate     = parseFloat(restaurant.taxRate) || 5;
  const discount    = parseFloat(req.body.discount) || 0;
  const discountAmt = Math.round(row.subtotal * discount / 100);
  const tax         = Math.round((row.subtotal - discountAmt) * taxRate / 100);
  const total       = row.subtotal - discountAmt + tax;

  db.prepare(`
    UPDATE orders SET discount = ?, discount_amt = ?, tax = ?, total = ?, updated_at = ? WHERE id = ?
  `).run(discount, discountAmt, tax, total, now(), req.params.id);

  res.json(rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id)));
});

router.post('/orders/:id/pay', (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Order not found' });

  const { method, amountPaid } = req.body;
  const paidAt = now();
  const change = amountPaid ? Math.max(0, amountPaid - row.total) : 0;

  const payOrder = db.transaction(() => {
    db.prepare(`
      UPDATE orders SET pay_status = 'paid', pay_method = ?, paid_at = ?, status = 'delivered', updated_at = ?
      WHERE id = ?
    `).run(method, paidAt, paidAt, req.params.id);

    if (row.table_id) {
      db.prepare(`
        UPDATE tables SET status = 'empty', order_id = NULL, open_time = NULL WHERE id = ?
      `).run(row.table_id);
    }

    db.prepare(`
      INSERT INTO transactions (id, order_id, amount, method, amount_paid, change, paid_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(`TXN-${Date.now()}`, req.params.id, row.total, method,
           amountPaid || row.total, change, paidAt);
  });

  payOrder();

  const order = rowToOrder(db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id));
  req.io?.emit('order_updated', order);
  req.io?.emit('tables_updated', getAllTables());
  res.json({ order, change });
});

// ── INVENTORY ────────────────────────────────────────────────────────────
router.get('/inventory', (req, res) => {
  res.json(db.prepare('SELECT * FROM inventory ORDER BY id').all());
});

router.post('/inventory', (req, res) => {
  const { name, unit, stock, min_stock, cost } = req.body;
  const result = db.prepare(
    'INSERT INTO inventory (name, unit, stock, min_stock, cost) VALUES (?, ?, ?, ?, ?)'
  ).run(name, unit || 'kg', stock || 0, min_stock || 0, cost || 0);
  res.json(db.prepare('SELECT * FROM inventory WHERE id = ?').get(result.lastInsertRowid));
});

router.put('/inventory/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const merged = { ...item, ...req.body, id: item.id };
  db.prepare(`
    UPDATE inventory SET name = ?, unit = ?, stock = ?, min_stock = ?, cost = ? WHERE id = ?
  `).run(merged.name, merged.unit, merged.stock, merged.min_stock, merged.cost, item.id);

  res.json(db.prepare('SELECT * FROM inventory WHERE id = ?').get(item.id));
});

router.post('/inventory/:id/restock', (req, res) => {
  const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const newStock = Math.round((item.stock + parseFloat(req.body.qty)) * 100) / 100;
  db.prepare('UPDATE inventory SET stock = ? WHERE id = ?').run(newStock, item.id);
  res.json(db.prepare('SELECT * FROM inventory WHERE id = ?').get(item.id));
});

// ── REPORTS ──────────────────────────────────────────────────────────────
router.get('/reports/summary', (req, res) => {
  // ── Date range from ?period=today|week|month (default: today) ──────────
  const period = req.query.period || 'today';
  const nowMs  = Date.now();
  let startMs;
  if (period === 'month') {
    const d = new Date(nowMs); d.setDate(1); d.setHours(0, 0, 0, 0);
    startMs = d.getTime();
  } else if (period === 'week') {
    const d = new Date(nowMs); d.setDate(d.getDate() - d.getDay()); d.setHours(0, 0, 0, 0);
    startMs = d.getTime();
  } else {
    // today
    const d = new Date(nowMs); d.setHours(0, 0, 0, 0);
    startMs = d.getTime();
  }
  const startTs = Math.floor(startMs / 1000); // SQLite stores seconds

  const paidOrders = db.prepare(
    "SELECT * FROM orders WHERE pay_status = 'paid' AND paid_at >= ?"
  ).all(startTs);

  // ── Core KPIs ──────────────────────────────────────────────────────────
  const revenue  = paidOrders.reduce((s, o) => s + o.total, 0);
  const avgBill  = paidOrders.length ? Math.round(revenue / paidOrders.length) : 0;
  const dineIn   = paidOrders.filter(o => o.table_id).length;
  const takeaway = paidOrders.filter(o => !o.table_id).length;

  // ── Item & category aggregation ────────────────────────────────────────
  const itemSales = {};
  let itemsSold = 0;
  const tableSet = new Set();

  for (const o of paidOrders) {
    if (o.table_id) tableSet.add(o.table_id);
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id);
    for (const i of items) {
      itemsSold += i.qty;
      if (!itemSales[i.menu_id]) {
        itemSales[i.menu_id] = { id: i.menu_id, name: i.name, cat: i.cat, price: i.price, qty: 0, revenue: 0 };
      }
      itemSales[i.menu_id].qty     += i.qty;
      itemSales[i.menu_id].revenue += i.price * i.qty;
    }
  }

  const topItems = Object.values(itemSales).sort((a, b) => b.revenue - a.revenue).slice(0, 8);

  const catSales = {};
  for (const i of Object.values(itemSales)) {
    catSales[i.cat] = (catSales[i.cat] || 0) + i.revenue;
  }

  // ── Payment method breakdown ────────────────────────────────────────────
  const payMethods = {};
  for (const o of paidOrders) {
    const m = o.pay_method || 'cash';
    payMethods[m] = (payMethods[m] || 0) + 1;
  }

  // ── Peak hours (bucket paid_at by hour, 0-23) ──────────────────────────
  const hourBuckets = {};
  for (const o of paidOrders) {
    const h = new Date(o.paid_at * 1000).getHours();
    hourBuckets[h] = (hourBuckets[h] || 0) + 1;
  }
  // Return as array of { hour: "HH", label: "H–H+1 AM/PM", count }
  const peakHours = Array.from({ length: 24 }, (_, h) => {
    const start = h % 12 || 12;
    const end   = (h + 1) % 12 || 12;
    const ampm  = h < 12 ? 'AM' : 'PM';
    const eampm = h + 1 < 12 ? 'AM' : 'PM';
    return {
      hour:  h,
      label: `${start}${ampm === eampm ? '' : ampm}–${end}${eampm}`,
      count: hourBuckets[h] || 0,
    };
  }).filter(p => p.count > 0 || (p.hour >= 10 && p.hour <= 22)); // show 10am–10pm always

  // ── Table turn ratio ────────────────────────────────────────────────────
  const totalTables = db.prepare('SELECT COUNT(*) as c FROM tables').get().c || 1;
  const tableTurns  = totalTables > 0
    ? (dineIn / totalTables).toFixed(1)
    : '0.0';

  res.json({
    period,
    revenue,
    orderCount:    paidOrders.length,
    avgBill,
    tableTurns,
    dineIn,
    takeaway,
    itemsSold,
    tablesServed:  tableSet.size,
    topItems,
    catSales,
    payMethods,
    peakHours,
  });
});

// ── STAFF ────────────────────────────────────────────────────────────────
router.get('/staff', (req, res) => {
  res.json(db.prepare('SELECT id, name, role, active FROM staff ORDER BY id').all());
});

router.post('/staff/login', (req, res) => {
  const member = db.prepare('SELECT * FROM staff WHERE pin = ? AND active = 1').get(req.body.pin);
  if (!member) return res.status(401).json({ error: 'Invalid PIN' });
  res.json({ id: member.id, name: member.name, role: member.role });
});

// ── QR INFO ──────────────────────────────────────────────────────────────
router.get('/qr/:tableId', (req, res) => {
  const row = db.prepare('SELECT * FROM tables WHERE id = ?').get(req.params.tableId);
  if (!row) return res.status(404).json({ error: 'Table not found' });
  const availableCount = db.prepare('SELECT COUNT(*) as c FROM menu WHERE available = 1').get().c;
  res.json({ table: rowToTable(row), restaurant: getRestaurant(), menuAvailable: availableCount });
});

module.exports = router;