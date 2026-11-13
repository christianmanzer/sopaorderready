// Read-only calls to the Toast API, used to double-check orders that the
// webhook has not updated. Needs the Toast API client ID and secret (orders:read).

var DEFAULT_HOST = 'https://ws-api.toasttab.com';

export function toastHost(env) {
  return String(env.TOAST_API_HOST || DEFAULT_HOST).replace(/\/+$/, '');
}

export function pollingEnabled(env) {
  return !!(env.TOAST_CLIENT_ID && env.TOAST_CLIENT_SECRET) && String(env.TOAST_POLL || 'on') !== 'off';
}

// Returns { token, expiresAt }. Pass the cached value back in to reuse it.
export async function getToken(env, cached, nowMs, fetchFn) {
  fetchFn = fetchFn || fetch;
  if (cached && cached.token && cached.expiresAt - nowMs > 5 * 60 * 1000) return cached;
  var res = await fetchFn(toastHost(env) + '/authentication/v1/authentication/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientId: env.TOAST_CLIENT_ID,
      clientSecret: env.TOAST_CLIENT_SECRET,
      userAccessType: 'TOAST_MACHINE_CLIENT',
    }),
  });
  if (!res.ok) throw new Error('toast login ' + res.status);
  var data = await res.json();
  var tok = data && data.token;
  if (!tok || !tok.accessToken) throw new Error('toast login: no token');
  var secs = Number(tok.expiresIn) || 3600;
  return { token: tok.accessToken, expiresAt: nowMs + secs * 1000 };
}

// Fetch one order. Returns the order object, or null if Toast says it does not exist.
export async function fetchOrder(env, token, restaurantGuid, orderGuid, fetchFn) {
  fetchFn = fetchFn || fetch;
  var res = await fetchFn(toastHost(env) + '/orders/v2/orders/' + encodeURIComponent(orderGuid), {
    headers: {
      authorization: 'Bearer ' + token,
      'Toast-Restaurant-External-ID': restaurantGuid,
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('toast order ' + res.status);
  return res.json();
}
