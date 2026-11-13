import test from 'node:test';
import assert from 'node:assert/strict';
import { getToken, fetchOrder, pollingEnabled, toastHost, cleanCred, credShape } from '../src/toast.js';

const env = { TOAST_CLIENT_ID: 'id', TOAST_CLIENT_SECRET: 'sec' };

test('polling is only on when both credentials are set (and not switched off)', () => {
  assert.equal(pollingEnabled({}), false);
  assert.equal(pollingEnabled({ TOAST_CLIENT_ID: 'id' }), false);
  assert.equal(pollingEnabled(env), true);
  assert.equal(pollingEnabled(Object.assign({ TOAST_POLL: 'off' }, env)), false);
  assert.equal(toastHost({ TOAST_API_HOST: 'http://localhost:9999/' }), 'http://localhost:9999');
});

test('getToken logs in once and reuses the token until near expiry', async () => {
  let calls = 0;
  const f = async (url, init) => {
    calls++;
    assert.match(url, /\/authentication\/v1\/authentication\/login$/);
    const b = JSON.parse(init.body);
    assert.equal(b.userAccessType, 'TOAST_MACHINE_CLIENT');
    return { ok: true, json: async () => ({ token: { accessToken: 'abc', expiresIn: 3600 } }) };
  };
  const t1 = await getToken(env, null, 1000, f);
  assert.equal(t1.token, 'abc');
  const t2 = await getToken(env, t1, 2000, f);
  assert.equal(calls, 1);
  assert.equal(t2, t1);
  await getToken(env, t1, 1000 + 3600 * 1000, f); // expired
  assert.equal(calls, 2);
});

test('getToken throws on a failed login', async () => {
  await assert.rejects(() => getToken(env, null, 0, async () => ({ ok: false, status: 401 })), /toast login 401/);
});

test('fetchOrder sends the restaurant header and handles 404', async () => {
  let seen;
  const ok = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ guid: 'g1' }) }; };
  const o = await fetchOrder(env, 'tok', 'rest-guid', 'g1', ok);
  assert.equal(o.guid, 'g1');
  assert.match(seen.url, /\/orders\/v2\/orders\/g1$/);
  assert.equal(seen.init.headers['Toast-Restaurant-External-ID'], 'rest-guid');
  assert.equal(seen.init.headers.authorization, 'Bearer tok');
  assert.equal(await fetchOrder(env, 't', 'r', 'g', async () => ({ ok: false, status: 404 })), null);
  await assert.rejects(() => fetchOrder(env, 't', 'r', 'g', async () => ({ ok: false, status: 500 })), /toast order 500/);
});

test('credentials are cleaned of stray spaces, newlines and quotes before login', async () => {
  assert.equal(cleanCred('  abc\n'), 'abc');
  assert.equal(cleanCred('"abc"'), 'abc');
  let sent;
  const f = async (url, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ token: { accessToken: 't', expiresIn: 60 } }) }; };
  await getToken({ TOAST_CLIENT_ID: ' myid\n', TOAST_CLIENT_SECRET: '"mysecret"' }, null, 0, f);
  assert.equal(sent.clientId, 'myid');
  assert.equal(sent.clientSecret, 'mysecret');
});

test('a failed login reports Toast\'s reply and the credential shape, never the secret', async () => {
  const e = { TOAST_CLIENT_ID: 'abcdefghij', TOAST_CLIENT_SECRET: 'supersecretvalue\n' };
  const f = async () => ({ ok: false, status: 401, text: async () => '{"message":"Invalid credentials"}' });
  await assert.rejects(() => getToken(e, null, 0, f), (err) => {
    assert.match(err.message, /toast login 401/);
    assert.match(err.message, /Invalid credentials/);
    assert.match(err.message, /id 10 chars abc…hij/);
    assert.match(err.message, /secret 16 chars \(had extra spaces/);
    assert.ok(!err.message.includes('supersecretvalue'));
    return true;
  });
  assert.match(credShape({ TOAST_CLIENT_ID: 'x'.repeat(8), TOAST_CLIENT_SECRET: 'x'.repeat(8) }), /SAME VALUE AS ID/);
});
