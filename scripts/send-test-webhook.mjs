#!/usr/bin/env node
// Sends a signed, Toast-shaped order_updated webhook to your board, so you can
// test the whole chain without placing a real order.
//
//   node scripts/send-test-webhook.mjs --url http://localhost:8787 \
//        --secret test-secret --restaurant TEST-RESTAURANT --number 42 --status preparing
//
// --status   preparing | ready | mixed | unfired | voided | dine-in
// --order    reuse the same order id to move an order from preparing to ready
// --name     tab name on the check (shown when showNames is on)
// --raw      send the body but with a wrong signature, to confirm it is rejected
import { createHmac, randomUUID } from 'node:crypto';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const next = process.argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
    else { args[a.slice(2)] = next; i++; }
  }
}

const url = (args.url || 'http://localhost:8787').replace(/\/$/, '');
const secret = args.secret || process.env.TOAST_WEBHOOK_SECRET || 'test-secret';
const restaurant = args.restaurant || 'REPLACE-WITH-TOAST-RESTAURANT-GUID';
const number = String(args.number || Math.floor(Math.random() * 90) + 10);
const status = args.status || 'preparing';
const orderGuid = args.order || randomUUID();

const now = new Date().toISOString();
const sel = (fulfillmentStatus, displayName) => ({
  guid: randomUUID(),
  entityType: 'MenuItemSelection',
  displayName,
  quantity: 1,
  fulfillmentStatus,
  voided: false,
  modifiedDate: now,
});

const selections = {
  preparing: [sel('SENT', 'Green chile burrito'), sel('SENT', 'Horchata')],
  ready: [sel('READY', 'Green chile burrito'), sel('READY', 'Horchata')],
  mixed: [sel('READY', 'Horchata'), sel('SENT', 'Green chile burrito')],
  unfired: [sel('NEW', 'Green chile burrito')],
  voided: [sel('SENT', 'Green chile burrito')],
  'dine-in': [sel('SENT', 'Green chile burrito')],
}[status];
if (!selections) { console.error('Unknown --status ' + status); process.exit(1); }

const order = {
  guid: orderGuid,
  entityType: 'Order',
  openedDate: now,
  modifiedDate: now,
  voided: status === 'voided',
  deleted: false,
  source: 'In Store',
  diningOption: { guid: 'TEST-TAKEOUT', entityType: 'DiningOption' },
  checks: [{
    guid: randomUUID(),
    entityType: 'Check',
    displayNumber: number,
    tabName: args.name || null,
    voided: false,
    deleted: false,
    selections,
  }],
};
if (status === 'dine-in') order.table = { guid: 'TEST-TABLE', entityType: 'Table' };

const body = {
  timestamp: now,
  eventCategory: 'orders',
  eventType: 'order_updated',
  guid: randomUUID(),
  details: { restaurantGuid: restaurant, order },
};
const raw = JSON.stringify(body);
const signature = args.raw
  ? 'bm90IGEgcmVhbCBzaWduYXR1cmU='
  : createHmac('sha256', secret).update(raw + body.timestamp).digest('base64');

const res = await fetch(url + '/webhook/toast', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'Toast-Signature': signature,
    'Toast-Restaurant-External-ID': restaurant,
  },
  body: raw,
});
console.log(`order ${number} (${orderGuid}) as "${status}" -> HTTP ${res.status} ${await res.text()}`);
