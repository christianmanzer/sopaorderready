import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { summarizeOrder, applyEvent, pruneOrders, visibleOrders, parseMs, cleanName, findName, findEta, DEFAULTS } from '../src/logic.js';
import { verifyToastSignature } from '../src/signature.js';

const NOW = Date.parse('2026-11-13T18:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function order(statuses, extra) {
  return Object.assign({
    guid: 'o1',
    voided: false,
    deleted: false,
    checks: [{
      displayNumber: '42',
      voided: false,
      deleted: false,
      selections: statuses.map((s) => ({ fulfillmentStatus: s, voided: false, modifiedDate: iso(NOW - 60000) })),
    }],
  }, extra || {});
}
const show = (o, opts) => summarizeOrder(o, Object.assign({ nowMs: NOW }, opts || {}));

test('sent items mean preparing', () => {
  const r = show(order(['SENT', 'SENT']));
  assert.equal(r.action, 'show');
  assert.equal(r.order.status, 'preparing');
  assert.equal(r.order.number, '42');
});

test('all ready means ready', () => {
  assert.equal(show(order(['READY', 'READY'])).order.status, 'ready');
});

test('one item still sent keeps the order in preparing', () => {
  assert.equal(show(order(['READY', 'SENT'])).order.status, 'preparing');
});

test('held or unsent items do not block ready or show an order by themselves', () => {
  assert.equal(show(order(['READY', 'HOLD', 'NEW'])).order.status, 'ready');
  assert.equal(show(order(['NEW'])).action, 'remove');
});

test('voided selections are ignored', () => {
  const o = order(['SENT', 'READY']);
  o.checks[0].selections[0].voided = true;
  assert.equal(show(o).order.status, 'ready');
});

test('voided order is removed', () => {
  assert.equal(show(order(['SENT'], { voided: true })).action, 'remove');
});

test('table orders are skipped unless included', () => {
  assert.equal(show(order(['SENT'], { table: { guid: 't' } })).reason, 'table-order');
  assert.equal(show(order(['SENT'], { table: { guid: 't' } }), { includeTableOrders: true }).action, 'show');
});

test('dining option filter keeps only listed options', () => {
  const o = order(['SENT'], { diningOption: { guid: 'takeout' } });
  assert.equal(show(o, { diningOptionGuids: ['takeout'] }).action, 'show');
  assert.equal(show(o, { diningOptionGuids: ['delivery'] }).action, 'remove');
});

test('tip adjustments long after service are ignored', () => {
  const o = order(['READY']);
  o.checks[0].selections[0].modifiedDate = iso(NOW - 5 * 60 * 60 * 1000);
  assert.equal(show(o).reason, 'old-order');
});

test('names only show when enabled, first name only', () => {
  const o = order(['SENT']);
  o.checks[0].tabName = 'Maria Garcia Lopez';
  assert.equal(show(o).order.name, null);
  assert.equal(show(o, { showNames: true }).order.name, 'Maria');
});

test('order number falls back to the check number, and missing numbers are ignored', () => {
  assert.equal(show(order(['SENT'], { displayNumber: '7' })).order.number, '7');
  const o = order(['SENT']);
  delete o.checks[0].displayNumber;
  assert.equal(show(o).action, 'ignore');
});

test('Toast timestamps with +0000 offsets parse', () => {
  assert.equal(parseMs('2026-11-13T18:00:00.000+0000'), NOW);
  assert.equal(parseMs('nonsense'), null);
});

test('events move an order preparing -> ready -> expired, and it stays gone', () => {
  const orders = {};
  assert.equal(applyEvent(orders, 'o1', show(order(['SENT'])), NOW, NOW), true);
  assert.deepEqual(visibleOrders(orders).map((o) => o.s), ['preparing']);

  assert.equal(applyEvent(orders, 'o1', show(order(['READY'])), NOW + 1000, NOW + 1000), true);
  assert.deepEqual(visibleOrders(orders).map((o) => o.s), ['ready']);
  const readyAt = orders.o1.r;

  // Another "ready" snapshot (payment) must not restart the clock.
  applyEvent(orders, 'o1', show(order(['READY'])), NOW + 5000, NOW + 5000);
  assert.equal(orders.o1.r, readyAt);

  const later = NOW + DEFAULTS.readyMs + 60000;
  assert.equal(pruneOrders(orders, later), true);
  assert.equal(visibleOrders(orders).length, 0);

  // A later ready-state webhook (refund, tip adjust) does not bring it back.
  assert.equal(applyEvent(orders, 'o1', show(order(['READY'])), later + 1000, later + 1000), false);
  assert.equal(visibleOrders(orders).length, 0);
});

test('a late retry carrying older state is ignored', () => {
  const orders = {};
  applyEvent(orders, 'o1', show(order(['READY'])), NOW + 10000, NOW + 10000);
  const changed = applyEvent(orders, 'o1', show(order(['SENT'])), NOW, NOW + 20000);
  assert.equal(changed, false);
  assert.equal(orders.o1.s, 'ready');
});

test('a voided order leaves the board', () => {
  const orders = {};
  applyEvent(orders, 'o1', show(order(['SENT'])), NOW, NOW);
  applyEvent(orders, 'o1', show(order(['SENT'], { voided: true })), NOW + 1000, NOW + 1000);
  assert.equal(visibleOrders(orders).length, 0);
});

test('orders never marked ready drop off after the prep limit', () => {
  const orders = {};
  applyEvent(orders, 'o1', show(order(['SENT'])), NOW, NOW);
  assert.equal(pruneOrders(orders, NOW + DEFAULTS.prepMs + 1000), true);
  assert.equal(visibleOrders(orders).length, 0);
});

test('signature: valid, tampered, wrong secret, missing', async () => {
  const body = JSON.stringify({ timestamp: '2026-11-13T18:00:00.000Z', hello: 'world' });
  const ts = '2026-11-13T18:00:00.000Z';
  const sig = createHmac('sha256', 'abc').update(body + ts).digest('base64');
  assert.equal(await verifyToastSignature(['abc'], body, ts, sig), true);
  assert.equal(await verifyToastSignature(['nope', 'abc'], body, ts, sig), true);
  assert.equal(await verifyToastSignature(['abc'], body + ' ', ts, sig), false);
  assert.equal(await verifyToastSignature(['other'], body, ts, sig), false);
  assert.equal(await verifyToastSignature(['abc'], body, ts, ''), false);
  assert.equal(await verifyToastSignature([], body, ts, sig), false);
  assert.equal(await verifyToastSignature(['abc'], body, ts, '%%%not-base64'), false);
});

test('names: first name only, tidy case, accents kept', () => {
  assert.equal(cleanName('Maria Garcia Lopez'), 'Maria');
  assert.equal(cleanName('MARIA'), 'Maria');
  assert.equal(cleanName('maria'), 'Maria');
  assert.equal(cleanName('  José  '), 'José');
  assert.equal(cleanName("D'Angelo R"), "D'Angelo");
  assert.equal(cleanName('McDonald'), 'McDonald'); // mixed case is left alone
  assert.equal(cleanName('Bartholomew-Montgomery'), 'Bartholomew-Mo');
  assert.equal(cleanName('Bartholomew-Montgomery').length, 14); // capped at 14
});

test('names: ids, phone numbers, blanks and single letters are skipped', () => {
  assert.equal(cleanName('DD 4471'), null);
  assert.equal(cleanName('5055551234'), null);
  assert.equal(cleanName('Table 5'), null);
  assert.equal(cleanName('J'), null);
  assert.equal(cleanName('   '), null);
  assert.equal(cleanName(null), null);
  assert.equal(cleanName('<script>'), 'Script'); // markup characters are stripped
});

test('names: customer first name wins over tab name; tab name is the fallback', () => {
  const both = order(['SENT']);
  both.checks[0].tabName = 'Front counter';
  both.checks[0].customer = { firstName: 'priya' };
  assert.deepEqual(findName(both), { name: 'Priya', source: 'customer' });

  const tabOnly = order(['SENT']);
  tabOnly.checks[0].tabName = 'Sam R';
  assert.deepEqual(findName(tabOnly), { name: 'Sam', source: 'tab' });

  const none = order(['SENT']);
  assert.deepEqual(findName(none), { name: null, source: null });
});

test('names: shown only when enabled, and the log source is reported either way', () => {
  const o = order(['SENT']);
  o.checks[0].tabName = 'Maria';
  const off = show(o);
  assert.equal(off.order.name, null);
  assert.equal(off.nameSource, 'tab');
  assert.equal(show(o, { showNames: true }).order.name, 'Maria');
});

test('names: an order whose name changes updates the board', () => {
  const orders = {};
  const o = order(['SENT']);
  applyEvent(orders, 'o1', show(o, { showNames: true }), NOW, NOW);
  o.checks[0].tabName = 'Ben';
  assert.equal(applyEvent(orders, 'o1', show(o, { showNames: true }), NOW + 1000, NOW + 1000), true);
  assert.equal(visibleOrders(orders)[0].name, 'Ben');
});

test('findEta prefers estimatedFulfillmentDate, falls back to promisedDate, ignores bad data', () => {
  const soon = NOW + 12 * 60 * 1000;
  assert.deepEqual(findEta({ estimatedFulfillmentDate: iso(soon) }, NOW), { ms: soon, source: 'estimated' });
  assert.deepEqual(findEta({ promisedDate: iso(soon) }, NOW), { ms: soon, source: 'promised' });
  assert.equal(findEta({ estimatedFulfillmentDate: iso(soon), promisedDate: iso(soon + 60000) }, NOW).source, 'estimated');
  assert.equal(findEta({ estimatedFulfillmentDate: iso(NOW + 30 * 3600 * 1000) }, NOW).ms, null);
  assert.equal(findEta({}, NOW).ms, null);
  assert.equal(findEta({ estimatedFulfillmentDate: 'garbage' }, NOW).ms, null);
});

test('estimate is only carried to the board when showEstimates is on, and survives storage', () => {
  const soon = NOW + 10 * 60 * 1000;
  const o = order(['SENT'], { estimatedFulfillmentDate: iso(soon) });
  const off = summarizeOrder(o, { nowMs: NOW });
  assert.equal(off.order.eta, null);
  assert.equal(off.etaSource, 'estimated'); // still reported for the setup log
  const on = summarizeOrder(o, { nowMs: NOW, showEstimates: true });
  assert.equal(on.order.eta, soon);
  const orders = {};
  applyEvent(orders, 'o1', on, NOW, NOW);
  assert.equal(visibleOrders(orders, NOW)[0].e, soon);
});

test('mixed READY and SENT order is promoted to ready after mixedMs, and stays ready on repeat events', () => {
  const o = order(['READY', 'READY', 'SENT']);
  const r = summarizeOrder(o, { nowMs: NOW });
  assert.equal(r.order.status, 'preparing');
  assert.equal(r.order.mixed, true);
  const orders = {};
  applyEvent(orders, 'o1', r, NOW, NOW);
  assert.equal(orders.o1.m, NOW);
  // not yet
  assert.equal(pruneOrders(orders, NOW + 2 * 60000, { mixedMs: 3 * 60000 }), false);
  assert.equal(visibleOrders(orders)[0].s, 'preparing');
  // promoted
  assert.equal(pruneOrders(orders, NOW + 3 * 60000, { mixedMs: 3 * 60000 }), true);
  assert.equal(visibleOrders(orders)[0].s, 'ready');
  const readyAt = orders.o1.r;
  // Toast repeats the same mixed state: must stay ready, with the original ready time
  applyEvent(orders, 'o1', r, NOW + 4 * 60000, NOW + 4 * 60000);
  assert.equal(orders.o1.s, 'ready');
  assert.equal(orders.o1.r, readyAt);
  // a new item is added (all SENT again): back to preparing
  const r2 = summarizeOrder(order(['SENT', 'SENT', 'SENT']), { nowMs: NOW });
  assert.equal(r2.order.mixed, false);
  applyEvent(orders, 'o1', r2, NOW + 5 * 60000, NOW + 5 * 60000);
  assert.equal(orders.o1.s, 'preparing');
  assert.equal(orders.o1.m, undefined);
});

test('an order that is all SENT or all READY is never marked mixed', () => {
  assert.equal(summarizeOrder(order(['SENT', 'SENT']), { nowMs: NOW }).order.mixed, false);
  assert.equal(summarizeOrder(order(['READY', 'READY']), { nowMs: NOW }).order.mixed, false);
});
