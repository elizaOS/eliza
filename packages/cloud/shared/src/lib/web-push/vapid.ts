/**
 * VAPID (Voluntary Application Server Identification, RFC 8292) JWT signing.
 *
 * Signs an ES256 JWT over the push endpoint's origin (`aud`), a contact `sub`
 * (mailto:/https:), and a short `exp`. The private key is a P-256 key supplied
 * as a base64url raw scalar (`d`) — exactly what `web-push generate-vapid-keys`
 * emits as the "private key". We import it as a JWK and sign with WebCrypto's
 * `ECDSA` (P-256, SHA-256), which produces the raw r||s signature the JWS
 * `ES256` alg requires (NOT DER) — so no ASN.1 re-encoding is needed.
 *
 * Cloudflare-Workers compatible: uses only `crypto.subtle` + base64url helpers,
 * no Node `crypto`, no `Buffer`, no `web-push` npm package.
 */

import { base64UrlToBytes, bytesToBase64Url, stringToBase64Url } from "./base64url";

/** Max VAPID JWT lifetime per RFC 8292 §2 is 24h; we default well under it. */
export const DEFAULT_VAPID_JWT_TTL_SECONDS = 12 * 60 * 60;

export interface VapidKeys {
  /** base64url uncompressed P-256 public point (65 bytes, 0x04 prefix). */
  publicKey: string;
  /** base64url raw P-256 private scalar `d` (32 bytes). */
  privateKey: string;
}

export interface SignVapidJwtOptions {
  /** Push service origin, e.g. `https://web.push.apple.com` (scheme+host). */
  audience: string;
  /** Contact URI: `mailto:you@example.com` or an https URL. */
  subject: string;
  /** base64url raw P-256 private scalar. */
  privateKey: string;
  /** base64url uncompressed public point (needed to build the signing JWK). */
  publicKey: string;
  /** Override expiry (seconds since epoch). Defaults to now + TTL. */
  expiresAt?: number;
  /** Injectable clock for tests (ms since epoch). */
  now?: () => number;
}

/** Derive the `scheme://host` origin used as the JWT `aud`. Throws on garbage. */
export function pushEndpointAudience(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

/**
 * Build a P-256 signing key from raw base64url `d` + public point. We derive
 * the `x`/`y` JWK coordinates from the 65-byte uncompressed public point so the
 * caller only has to persist the two base64url strings web-push emits.
 */
async function importVapidSigningKey(privateKey: string, publicKey: string): Promise<CryptoKey> {
  const pub = base64UrlToBytes(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point (0x04 prefix)");
  }
  const x = bytesToBase64Url(pub.subarray(1, 33));
  const y = bytesToBase64Url(pub.subarray(33, 65));
  const d = privateKey; // already base64url raw scalar

  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x,
      y,
      d,
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * Sign a VAPID JWT. Returns the compact `header.payload.signature` string.
 * The signature is raw r||s (64 bytes) base64url — the ES256 JWS format.
 */
export async function signVapidJwt(options: SignVapidJwtOptions): Promise<string> {
  const nowMs = (options.now ?? Date.now)();
  const nowSeconds = Math.floor(nowMs / 1000);
  const exp = options.expiresAt ?? nowSeconds + DEFAULT_VAPID_JWT_TTL_SECONDS;

  const header = stringToBase64Url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = stringToBase64Url(
    JSON.stringify({
      aud: options.audience,
      exp,
      sub: options.subject,
    }),
  );
  const signingInput = `${header}.${payload}`;

  const key = await importVapidSigningKey(options.privateKey, options.publicKey);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  const sigB64 = bytesToBase64Url(new Uint8Array(signature));
  return `${signingInput}.${sigB64}`;
}

/**
 * Build the Authorization + Crypto-Key header pair for the `vapid` scheme
 * (draft-ietf-webpush-vapid / the widely-deployed single-header `vapid` form).
 * Modern push services accept `Authorization: vapid t=<jwt>, k=<pubkey>`.
 */
export function buildVapidAuthHeader(jwt: string, publicKey: string): string {
  return `vapid t=${jwt}, k=${publicKey}`;
}
