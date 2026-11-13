// Toast webhook signature check.
//
// Toast computes HMAC-SHA256 over (raw request body + the message "timestamp"
// value), signs it with the subscription's secret key, Base64-encodes it and
// sends it in the Toast-Signature header. Each subscription has its own secret.
// Uses the Web Crypto API, available in Cloudflare Workers and Node 20+.

var encoder = new TextEncoder();

function base64ToBytes(b64) {
  try {
    var bin = atob(String(b64).trim());
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch (e) {
    return null;
  }
}

// True if the signature matches any of the given secrets.
export async function verifyToastSignature(secrets, rawBody, timestamp, signatureB64) {
  if (!secrets || !secrets.length || !signatureB64 || timestamp === undefined || timestamp === null) {
    return false;
  }
  var sig = base64ToBytes(signatureB64);
  if (!sig) return false;
  var data = encoder.encode(rawBody + String(timestamp));
  for (var i = 0; i < secrets.length; i++) {
    var key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secrets[i]),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    // subtle.verify compares in constant time.
    if (await crypto.subtle.verify('HMAC', key, sig, data)) return true;
  }
  return false;
}
