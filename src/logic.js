// Order board logic. Pure functions only: no Cloudflare APIs, so everything
// here can be tested with plain Node (see test/logic.test.mjs).
//
// How an order is classified, from Toast's selection fulfillmentStatus values:
//   NEW   - on the check, not sent to the kitchen yet   -> ignored
//   HOLD  - paused by staff                              -> ignored
//   SENT  - fired and showing on the KDS                 -> "preparing"
//   READY - bumped / marked ready on the KDS             -> counts toward "ready"
// An order is "preparing" while any selection is SENT, and "ready" once at
// least one selection is READY and none are still SENT.
// Toast only sets READY if the restaurant uses the Toast KDS.

var MIN = 60 * 1000;

export var DEFAULTS = {
  readyMs: 15 * MIN, // how long a ready number stays on the board
  prepMs: 90 * MIN, // a never-bumped order drops off after this long
  goneMs: 6 * 60 * MIN, // how long we remember removed orders (blocks stale retries)
  mixedMs: 3 * MIN, // some items READY and the rest stuck at SENT (e.g. a drink that never goes through the KDS): show as ready after this long
  maxFiredAgeMs: 3 * 60 * MIN, // ignore orders whose items were last fired longer ago than this
};

// Toast timestamps look like 2024-03-28T15:11:01.050+0000; normalize the
// offset so every JS engine parses them.
export function parseMs(value) {
  if (!value) return null;
  var s = String(value).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  var t = Date.parse(s);
  return isNaN(t) ? null : t;
}

function liveChecks(order) {
  var out = [];
  var checks = (order && order.checks) || [];
  for (var i = 0; i < checks.length; i++) {
    if (checks[i] && !checks[i].voided && !checks[i].deleted) out.push(checks[i]);
  }
  return out;
}

// Count top-level selections by fulfillment status, and find when the most
// recent fired selection was last modified.
export function inspectSelections(order) {
  var counts = { NEW: 0, HOLD: 0, SENT: 0, READY: 0 };
  var lastFiredMs = null;
  var checks = liveChecks(order);
  for (var i = 0; i < checks.length; i++) {
    var sels = checks[i].selections || [];
    for (var j = 0; j < sels.length; j++) {
      var sel = sels[j];
      if (!sel || sel.voided || sel.deleted) continue;
      var status = sel.fulfillmentStatus || 'NEW';
      if (counts[status] === undefined) continue;
      counts[status]++;
      if (status === 'SENT' || status === 'READY') {
        var m = parseMs(sel.modifiedDate);
        if (m !== null && (lastFiredMs === null || m > lastFiredMs)) lastFiredMs = m;
      }
    }
  }
  return { counts: counts, lastFiredMs: lastFiredMs };
}

// Make a typed name fit for a TV: first name only, letters only, tidy case.
// Anything with digits is skipped (order IDs, phone numbers, "DD 4471").
export function cleanName(raw) {
  if (!raw) return null;
  var s = String(raw).trim();
  if (!s || /\d/.test(s)) return null;
  var first = s.split(/\s+/)[0].replace(/[^A-Za-zÀ-ſ'.-]/g, '');
  if (first.replace(/[^A-Za-zÀ-ſ]/g, '').length < 2) return null;
  if (first === first.toUpperCase() || first === first.toLowerCase()) {
    first = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }
  return first.slice(0, 14);
}

// Where a guest name can live on an order. The customer's first name is the
// cleanest source but Toast only includes it when the API client has the
// guest.pi:read scope. The tab name needs no extra scope and is what staff
// type at the counter. Returns { name, source } where source is
// 'customer' | 'tab' | null.
export function findName(order) {
  var checks = liveChecks(order);
  var customers = [order && order.customer];
  for (var i = 0; i < checks.length; i++) customers.push(checks[i].customer);
  for (var c = 0; c < customers.length; c++) {
    var n = customers[c] && cleanName(customers[c].firstName);
    if (n) return { name: n, source: 'customer' };
  }
  for (var t = 0; t < checks.length; t++) {
    var tn = cleanName(checks[t].tabName);
    if (tn) return { name: tn, source: 'tab' };
  }
  return { name: null, source: null };
}

// When Toast expects the order to be ready. estimatedFulfillmentDate is set by
// Toast (opened time plus prep time, plus throttling for takeout); promisedDate
// is the scheduled time for future orders. Returns { ms, source } where source
// is 'estimated' | 'promised' | null. Anything more than 12 hours from now is
// treated as bad data.
export function findEta(order, nowMs) {
  var cands = [['estimated', order && order.estimatedFulfillmentDate], ['promised', order && order.promisedDate]];
  for (var i = 0; i < cands.length; i++) {
    var ms = parseMs(cands[i][1]);
    if (ms !== null && Math.abs(ms - nowMs) <= 12 * 60 * MIN) return { ms: ms, source: cands[i][0] };
  }
  return { ms: null, source: null };
}

// Turn a Toast Order object into an instruction for the board:
//   { action: 'show',   order: { number, status, name, eta }, reason }
//   { action: 'remove', reason }   make sure it is not on the board
//   { action: 'ignore', reason }   change nothing
// opts: { diningOptionGuids: [], includeTableOrders: false, showNames: false,
//         showEstimates: false, nowMs, maxFiredAgeMs }
export function summarizeOrder(order, opts) {
  opts = opts || {};
  if (!order || !order.guid) return { action: 'ignore', reason: 'no-order' };
  if (order.voided || order.deleted) return { action: 'remove', reason: 'voided' };

  var wanted = opts.diningOptionGuids || [];
  if (wanted.length) {
    var dining = order.diningOption && order.diningOption.guid;
    if (wanted.indexOf(dining) === -1) return { action: 'remove', reason: 'dining-option-filtered' };
  } else if (order.table && !opts.includeTableOrders) {
    return { action: 'remove', reason: 'table-order' };
  }

  var info = inspectSelections(order);
  var fired = info.counts.SENT + info.counts.READY;
  if (fired === 0) return { action: 'remove', reason: 'not-fired' };

  var nowMs = opts.nowMs || Date.now();
  var maxAge = opts.maxFiredAgeMs || DEFAULTS.maxFiredAgeMs;
  if (info.lastFiredMs !== null && nowMs - info.lastFiredMs > maxAge) {
    // Late edits such as tip adjustments touch the order long after service.
    return { action: 'ignore', reason: 'old-order' };
  }

  var checks = liveChecks(order);
  var number = order.displayNumber;
  for (var i = 0; i < checks.length; i++) {
    if (!number && checks[i].displayNumber) number = checks[i].displayNumber;
  }
  if (!number) return { action: 'ignore', reason: 'no-number' };

  var status = info.counts.SENT > 0 ? 'preparing' : 'ready';
  var found = findName(order);
  var eta = findEta(order, nowMs);
  return {
    action: 'show',
    reason: status,
    nameSource: found.source, // for the setup log only; the name itself is never logged
    etaSource: eta.source,
    order: {
      number: String(number).slice(0, 8),
      status: status,
      mixed: info.counts.SENT > 0 && info.counts.READY > 0,
      name: opts.showNames ? found.name : null,
      eta: opts.showEstimates ? eta.ms : null,
    },
  };
}

// Apply one summarized event to the stored orders map. Returns true when the
// visible board changed. Stored shape per order:
//   { n, s: 'preparing'|'ready'|'gone', name, e: estimatedReadyMs, o: openedMs, r: readyMs, ts, g: goneMs }
export function applyEvent(orders, orderGuid, result, eventTs, nowMs) {
  var cur = orders[orderGuid];
  // A retried webhook can arrive minutes late carrying older state. Never go backwards.
  if (cur && eventTs && cur.ts && eventTs < cur.ts) return false;

  if (result.action === 'remove') {
    if (cur && cur.s !== 'gone') {
      orders[orderGuid] = { s: 'gone', ts: eventTs || nowMs, g: nowMs };
      return true;
    }
    return false;
  }
  if (result.action !== 'show') return false;

  var o = result.order;
  // Once an order has left the board, later "ready" snapshots (payment, refund,
  // tip adjust) must not bring it back. New items sent to the kitchen still do.
  if (cur && cur.s === 'gone' && o.status === 'ready') return false;

  var next = {
    n: o.number,
    s: o.status,
    name: o.name || null,
    e: o.eta || null,
    o: cur && cur.s !== 'gone' ? cur.o : nowMs,
    r: null,
    ts: eventTs || nowMs,
  };
  if (o.status === 'ready') next.r = cur && cur.s === 'ready' ? cur.r : nowMs;
  // Some items READY, the rest still SENT. Remember when that started so
  // pruneOrders can promote it to ready if it stays that way (see mixedMs).
  if (o.mixed) {
    next.m = cur && cur.m ? cur.m : nowMs;
    // Already promoted to ready: repeat events with the same mixed state must not undo it.
    if (cur && cur.s === 'ready' && cur.m) { next.s = 'ready'; next.r = cur.r; }
  }

  var changed = !cur || cur.s === 'gone' || cur.n !== next.n || cur.s !== next.s || cur.name !== next.name || cur.e !== next.e;
  orders[orderGuid] = next;
  return changed;
}

// Expire old orders. Returns true when the visible board changed.
export function pruneOrders(orders, nowMs, limits) {
  limits = limits || {};
  var readyMs = limits.readyMs || DEFAULTS.readyMs;
  var prepMs = limits.prepMs || DEFAULTS.prepMs;
  var goneMs = limits.goneMs || DEFAULTS.goneMs;
  var mixedMs = limits.mixedMs || DEFAULTS.mixedMs;
  var changed = false;
  var guids = Object.keys(orders);
  for (var i = 0; i < guids.length; i++) {
    var guid = guids[i];
    var o = orders[guid];
    if (o.s === 'ready' && nowMs - o.r > readyMs) {
      orders[guid] = { s: 'gone', ts: o.ts, g: nowMs };
      changed = true;
    } else if (o.s === 'preparing' && o.m && nowMs - o.m >= mixedMs) {
      o.s = 'ready';
      o.r = nowMs;
      changed = true;
    } else if (o.s === 'preparing' && nowMs - o.o > prepMs) {
      orders[guid] = { s: 'gone', ts: o.ts, g: nowMs };
      changed = true;
    } else if (o.s === 'gone' && nowMs - o.g > goneMs) {
      delete orders[guid];
    }
  }
  return changed;
}

export function visibleOrders(orders) {
  var out = [];
  var guids = Object.keys(orders);
  for (var i = 0; i < guids.length; i++) {
    var o = orders[guids[i]];
    if (o.s === 'preparing' || o.s === 'ready') {
      out.push({ n: o.n, s: o.s, name: o.name || null, e: o.e || null, o: o.o, r: o.r });
    }
  }
  return out;
}
