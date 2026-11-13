import { DurableObject } from 'cloudflare:workers';
import { DEFAULTS, summarizeOrder, applyEvent, pruneOrders, visibleOrders, inspectSelections } from './logic.js';
import { pollingEnabled, getToken, fetchOrder } from './toast.js';
import { verifyToastSignature } from './signature.js';

const MINUTE = 60 * 1000;
const POLL_EVERY_MS = 60 * 1000; // ask Toast about one order at most this often
const POLL_AFTER_MS = 90 * 1000; // leave a brand-new order alone for this long
const POLL_MAX_PER_RUN = 6;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function limitsFor(env) {
  return {
    readyMs: (Number(env.READY_MINUTES) || 15) * MINUTE,
    prepMs: (Number(env.PREP_MINUTES) || 90) * MINUTE,
    goneMs: DEFAULTS.goneMs,
    // 0 is allowed and means "no wait"; only a missing or invalid value falls back to 3.
    mixedMs: (env.MIXED_READY_MINUTES !== undefined && env.MIXED_READY_MINUTES !== '' && Number(env.MIXED_READY_MINUTES) >= 0
      ? Number(env.MIXED_READY_MINUTES) : 3) * MINUTE,
  };
}

function getLocation(env, slug) {
  const all = env.LOCATIONS || {};
  return Object.prototype.hasOwnProperty.call(all, slug) ? all[slug] : null;
}

// Theme keys in wrangler.toml -> CSS variables on the board page.
var THEME_VARS = {
  background: '--bg', ready: '--ready-bg', readyInk: '--ready-ink', preparing: '--prep-ink',
  muted: '--prep-dim', accent: '--accent', readyChip: '--chip-ready', readyChipInk: '--chip-ready-ink',
  preparingChip: '--chip-prep', preparingChipInk: '--chip-prep-ink',
};
var COLOR_OK = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9\s.,%]+\))$/;

function themeCss(theme) {
  var out = '';
  Object.keys(THEME_VARS).forEach(function (k) {
    var v = theme && theme[k];
    if (typeof v === 'string' && COLOR_OK.test(v.trim())) out += THEME_VARS[k] + ':' + v.trim() + ';';
  });
  return out;
}

// The board page with this location's colors already in it, so the screen
// never flashes the default colors while it loads.
async function serveBoard(request, env, url, loc) {
  const res = await env.ASSETS.fetch(new Request(new URL('/board.html', url), { headers: request.headers }));
  const css = themeCss(loc.theme);
  if (!css) return res;
  return new HTMLRewriter()
    .on('head', { element(el) { el.append('<style>:root{' + css + '}</style>', { html: true }); } })
    .transform(res);
}

function boardStub(env, slug) {
  return env.BOARD.get(env.BOARD.idFromName(slug));
}

async function logEvent(env, entry) {
  try {
    await env.LOG.get(env.LOG.idFromName('main')).fetch('https://log/append', {
      method: 'POST',
      body: JSON.stringify(entry),
    });
  } catch (err) {
    console.error('log failed', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// Toast webhook receiver
// ---------------------------------------------------------------------------
async function handleWebhook(request, env) {
  const raw = await request.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return json({ error: 'invalid json' }, 400);
  }

  const secrets = String(env.TOAST_WEBHOOK_SECRETS || env.TOAST_WEBHOOK_SECRET || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const sigOk = await verifyToastSignature(
    secrets,
    raw,
    body.timestamp,
    request.headers.get('Toast-Signature')
  );
  const enforce = String(env.SIGNATURE_MODE || 'enforce') !== 'log-only';

  const details = body.details || {};
  const order = details.order || details;
  const restaurantGuid =
    request.headers.get('Toast-Restaurant-External-ID') || details.restaurantGuid || null;
  const nowIso = new Date().toISOString();
  const base = {
    t: nowIso,
    type: body.eventType || null,
    restaurant: restaurantGuid,
    order: order && order.guid ? String(order.guid).slice(0, 8) : null,
    sigOk,
  };

  if (!sigOk && enforce) {
    await logEvent(env, Object.assign(base, { action: 'rejected: ' + (secrets.length ? 'bad signature' : 'no secret set') }));
    return json({ error: 'invalid signature' }, 401);
  }

  const type = body.eventType || '';
  if (type !== 'order_updated' && type !== 'channel_order_updated') {
    await logEvent(env, Object.assign(base, { action: 'ignored event type' }));
    return json({ ok: true, ignored: true });
  }

  const locations = env.LOCATIONS || {};
  const slugs = Object.keys(locations).filter(
    (slug) => locations[slug].restaurantGuid && locations[slug].restaurantGuid === restaurantGuid
  );
  if (!slugs.length) {
    await logEvent(env, Object.assign(base, {
      action: 'no board for this restaurant GUID',
      number: (order.displayNumber || (order.checks && order.checks[0] && order.checks[0].displayNumber) || null),
    }));
    return json({ ok: true, unmapped: true });
  }

  const nowMs = Date.now();
  const eventTs = Date.parse(body.timestamp) || nowMs;
  let failed = false;
  for (const slug of slugs) {
    const loc = locations[slug];
    let result;
    try {
      result = summarizeOrder(order, {
        diningOptionGuids: loc.diningOptionGuids || [],
        includeTableOrders: !!loc.includeTableOrders,
        showNames: !!loc.showNames,
        showEstimates: !!loc.showEstimate,
        nowMs,
      });
    } catch (err) {
      // Leave a trace in the setup log instead of failing silently.
      await logEvent(env, Object.assign({}, base, { board: slug, action: 'error: ' + String(err && err.message).slice(0, 120) }));
      failed = true;
      continue;
    }
    try {
      await boardStub(env, slug).fetch('https://board/event', {
        method: 'POST',
        body: JSON.stringify({ eventGuid: body.guid || null, orderGuid: order.guid, result, ts: eventTs, slug, restaurantGuid }),
      });
    } catch (err) {
      failed = true;
      console.error('board update failed', err && err.message);
    }
    let counts = {};
    try {
      const c = inspectSelections(order).counts;
      Object.keys(c).forEach((k) => { if (c[k]) counts[k] = c[k]; });
    } catch (e) {
      counts = { error: 'unreadable' };
    }
    await logEvent(env, Object.assign({}, base, {
      board: slug,
      number: result.order ? result.order.number : order.displayNumber || null,
      action: result.action + ': ' + result.reason,
      statuses: counts,
      nameFound: result.nameSource || null,
      etaFound: result.etaSource || null,
      diningOption: (order.diningOption && order.diningOption.guid) || null,
      tableOrder: !!order.table,
      source: order.source || null,
      toastTime: body.timestamp || null,
    }));
  }
  // A 5xx makes Toast resend later; the board ignores older state on retry.
  return failed ? json({ error: 'temporary failure' }, 500) : json({ ok: true });
}

// ---------------------------------------------------------------------------
// Admin: recent webhook log, used during setup
// ---------------------------------------------------------------------------
async function handleAdmin(request, env, url) {
  if (!env.ADMIN_KEY) return json({ error: 'not found' }, 404);
  const key = url.searchParams.get('key') || request.headers.get('x-admin-key');
  if (key !== env.ADMIN_KEY) return json({ error: 'unauthorized' }, 401);
  return env.LOG.get(env.LOG.idFromName('main')).fetch('https://log/recent');
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/webhook/toast') {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        return await handleWebhook(request, env);
      }
      if (path === '/admin/recent') return await handleAdmin(request, env, url);

      // Board page: /sopa/orderready (or the short form /b/sopa)
      let m = path.match(/^\/([a-z0-9-]+)\/orderready\/?$/) || path.match(/^\/b\/([a-z0-9-]+)\/?$/);
      if (m) {
        const loc = getLocation(env, m[1]);
        if (!loc) return json({ error: 'unknown board' }, 404);
        return await serveBoard(request, env, url, loc);
      }

      m = path.match(/^\/api\/b\/([a-z0-9-]+)\/(config|state|ws)$/);
      if (m) {
        const slug = m[1];
        const loc = getLocation(env, slug);
        if (!loc) return json({ error: 'unknown board' }, 404);
        if (m[2] === 'config') {
          return json({
            name: loc.name || slug,
            theme: loc.theme || {},
            showNames: !!loc.showNames,
            showEstimate: !!loc.showEstimate,
            timezone: loc.timezone || 'America/Denver',
            appVersion: String(env.APP_VERSION || '1'),
          });
        }
        if (m[2] === 'state') return boardStub(env, slug).fetch('https://board/state?slug=' + slug);
        if (request.headers.get('Upgrade') !== 'websocket') {
          return new Response('Expected a WebSocket connection', { status: 426 });
        }
        return boardStub(env, slug).fetch(new Request('https://board/ws?slug=' + slug, request));
      }

      if (path === '/') {
        const links = Object.keys(env.LOCATIONS || {})
          .map((slug) => '/' + slug + '/orderready')
          .join('\n');
        return new Response('Order boards:\n' + links + '\n', { headers: { 'content-type': 'text/plain' } });
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error('request failed', err && err.stack);
      // A webhook that crashes the Worker used to leave no trace at all.
      if (path === '/webhook/toast') {
        await logEvent(env, { t: new Date().toISOString(), type: 'worker', action: 'server error: ' + String(err && err.message).slice(0, 160) });
      }
      return json({ error: 'server error' }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// Board: one per location. Stores orders, pushes changes to every open screen.
// Uses hibernating WebSockets, so it costs nothing while the kitchen is quiet.
// ---------------------------------------------------------------------------
export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Answers the page's "ping" without waking the object.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async load() {
    const stored = await this.ctx.storage.get(['orders', 'seen']);
    return { orders: stored.get('orders') || {}, seen: stored.get('seen') || [] };
  }

  async snapshot() {
    const nowMs = Date.now();
    const { orders } = await this.load();
    if (pruneOrders(orders, nowMs, limitsFor(this.env))) {
      await this.ctx.storage.put('orders', orders);
    }
    return {
      type: 'state',
      now: nowMs,
      v: String(this.env.APP_VERSION || '1'),
      orders: visibleOrders(orders),
    };
  }

  async broadcast() {
    const payload = JSON.stringify(await this.snapshot());
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch (e) {
        /* the socket is closing; the page reconnects on its own */
      }
    }
  }

  async scheduleSweep(orders) {
    if (!Object.keys(orders).length) return;
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + 30 * 1000);
    }
  }

  // Remember which location this board is, so the backup check to Toast works
  // even before the first webhook after a deploy. Open screens ask every few seconds.
  async rememberLocation(slug) {
    const loc = getLocation(this.env, slug);
    if (!loc || !loc.restaurantGuid) return;
    const meta = await this.ctx.storage.get('meta');
    if (meta && meta.slug === slug && meta.restaurantGuid === loc.restaurantGuid) return;
    await this.ctx.storage.put('meta', { slug, restaurantGuid: loc.restaurantGuid });
    const { orders } = await this.load();
    await this.scheduleSweep(orders);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const slugParam = url.searchParams.get('slug');
    if (slugParam) await this.rememberLocation(slugParam);

    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify(await this.snapshot()));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/state') return json(await this.snapshot());

    if (url.pathname === '/event' && request.method === 'POST') {
      const evt = await request.json();
      const { orders, seen } = await this.load();
      if (evt.eventGuid && seen.indexOf(evt.eventGuid) !== -1) {
        return json({ ok: true, duplicate: true });
      }
      const nowMs = Date.now();
      if (evt.slug && evt.restaurantGuid) await this.ctx.storage.put('meta', { slug: evt.slug, restaurantGuid: evt.restaurantGuid });
      let changed = applyEvent(orders, evt.orderGuid, evt.result, evt.ts, nowMs);
      if (pruneOrders(orders, nowMs, limitsFor(this.env))) changed = true;
      if (evt.eventGuid) {
        seen.push(evt.eventGuid);
        while (seen.length > 200) seen.shift();
      }
      await this.ctx.storage.put({ orders, seen });
      if (changed) await this.broadcast();
      await this.scheduleSweep(orders);
      return json({ ok: true, changed });
    }

    return json({ error: 'not found' }, 404);
  }

  // Runs every 30 seconds while there is anything to expire.
  async alarm() {
    const nowMs = Date.now();
    const { orders } = await this.load();
    let changed = pruneOrders(orders, nowMs, limitsFor(this.env));
    try {
      if (await this.pollToast(orders, nowMs)) changed = true;
    } catch (err) {
      console.error('poll failed', err && err.message);
    }
    await this.ctx.storage.put('orders', orders);
    if (changed) await this.broadcast();
    await this.scheduleSweep(orders);
  }

  // Safety net: ask Toast directly about orders still showing as Preparing, in
  // case the webhook for a later change never arrived. Only runs when the Toast
  // API client ID and secret are set. Read-only; at most a few calls per run.
  async pollToast(orders, nowMs) {
    if (!pollingEnabled(this.env)) return false;
    const meta = await this.ctx.storage.get('meta');
    const loc = meta && getLocation(this.env, meta.slug);
    if (!loc) return false;

    const due = Object.keys(orders)
      .filter((g) => {
        const o = orders[g];
        return o.s === 'preparing' && nowMs - (o.lp || o.ts || o.o) >= POLL_EVERY_MS && nowMs - o.o >= POLL_AFTER_MS;
      })
      .slice(0, POLL_MAX_PER_RUN);
    if (!due.length) return false;

    // After a failed login, wait 5 minutes before trying again so a bad
    // credential does not hit Toast every 30 seconds.
    const failedAt = (await this.ctx.storage.get('toastLoginFailAt')) || 0;
    if (nowMs - failedAt < 5 * MINUTE) return false;

    let changed = false;
    try {
      const cached = await this.ctx.storage.get('toastToken');
      let tok;
      try {
        tok = await getToken(this.env, cached, nowMs);
      } catch (loginErr) {
        await this.ctx.storage.put('toastLoginFailAt', nowMs);
        throw loginErr;
      }
      await this.ctx.storage.delete('toastLoginFailAt');
      await this.ctx.storage.put('toastToken', tok);
      for (const guid of due) {
        const before = orders[guid];
        const order = await fetchOrder(this.env, tok.token, meta.restaurantGuid, guid);
        if (!order) { before.lp = nowMs; continue; }
        const result = summarizeOrder(order, {
          diningOptionGuids: loc.diningOptionGuids || [],
          includeTableOrders: !!loc.includeTableOrders,
          showNames: !!loc.showNames,
          showEstimates: !!loc.showEstimate,
          nowMs,
        });
        const prevStatus = before.s;
        const c = applyEvent(orders, guid, result, nowMs, nowMs);
        if (orders[guid]) orders[guid].lp = nowMs;
        if (c) {
          changed = true;
          await logEvent(this.env, {
            t: new Date(nowMs).toISOString(),
            type: 'poll',
            board: meta.slug,
            order: guid.slice(0, 8),
            number: before.n,
            action: 'poll: ' + prevStatus + ' -> ' + (orders[guid] ? orders[guid].s : 'gone') + ' (' + result.action + ': ' + (result.reason || '') + ')',
            statuses: Object.fromEntries(Object.entries(inspectSelections(order).counts).filter(([, n]) => n)),
          });
        }
      }
      await this.ctx.storage.delete('pollErrAt');
    } catch (err) {
      // Log a failure at most every 10 minutes so the setup log stays readable.
      // A different message is logged right away.
      const lastErr = (await this.ctx.storage.get('pollErrAt')) || 0;
      const msg = String(err && err.message).slice(0, 320);
      const lastMsg = await this.ctx.storage.get('pollErrMsg');
      if (nowMs - lastErr > 10 * MINUTE || msg !== lastMsg) {
        await this.ctx.storage.put('pollErrAt', nowMs);
        await this.ctx.storage.put('pollErrMsg', msg);
        await logEvent(this.env, { t: new Date(nowMs).toISOString(), type: 'poll', board: meta.slug, action: 'poll error: ' + msg });
      }
    }
    return changed;
  }

  async webSocketMessage(ws, message) {
    if (message === 'state') ws.send(JSON.stringify(await this.snapshot()));
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code, 'closing');
    } catch (e) {
      /* already closed */
    }
  }

  async webSocketError() {}
}

// ---------------------------------------------------------------------------
// EventLog: the last 100 webhooks, for checking setup. No guest names stored.
// ---------------------------------------------------------------------------
export class EventLog extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    let entries = (await this.ctx.storage.get('entries')) || [];
    if (url.pathname === '/append' && request.method === 'POST') {
      entries.unshift(await request.json());
      entries = entries.slice(0, 100);
      await this.ctx.storage.put('entries', entries);
      return json({ ok: true });
    }
    if (url.pathname === '/recent') return json({ entries });
    return json({ error: 'not found' }, 404);
  }
}
