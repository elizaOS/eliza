/**
 * Web Push payload encryption — aes128gcm content coding (RFC 8188) with the
 * Web Push key derivation of RFC 8291.
 *
 * Flow (RFC 8291 §3.4):
 *  1. Generate an ephemeral P-256 ("as_") keypair on the app-server side.
 *  2. ECDH(as_private, ua_public) → `ecdh_secret`.
 *  3. PRK_key   = HKDF(salt=auth_secret, ikm=ecdh_secret,
 *                      info="WebPush: info\x00" || ua_public || as_public, L=32)
 *  4. CEK       = HKDF(salt=random16, ikm=PRK_key, info="Content-Encoding: aes128gcm\x00", L=16)
 *     NONCE     = HKDF(salt=random16, ikm=PRK_key, info="Content-Encoding: nonce\x00",     L=12)
 *  5. Encrypt padded plaintext (data || 0x02 || pad) with AES-128-GCM.
 *  6. Prepend the aes128gcm header: salt(16) || rs(4, big-endian) || idlen(1) || as_public(65).
 *
 * WebCrypto-only. Runs unmodified on Cloudflare Workers — no Node `crypto`,
 * no `Buffer`, no `web-push` npm package.
 */

import { base64UrlToBytes } from "./base64url";

const AES128GCM_TAG_BYTES = 16;
/** Record size — one record covers the whole (small) push payload. */
const DEFAULT_RECORD_SIZE = 4096;

export interface PushSubscriptionKeys {
  /** base64url uncompressed P-256 UA public key (`keys.p256dh`). */
  p256dh: string;
  /** base64url 16-byte auth secret (`keys.auth`). */
  auth: string;
}

export interface EncryptResult {
  /** The full aes128gcm body: header || ciphertext. POST this as the request body. */
  body: Uint8Array;
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** HKDF (RFC 5869) via WebCrypto, returning `length` bytes. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt as BufferSource,
      info: info as BufferSource,
    },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** ASCII bytes for the fixed HKDF `info` strings (with trailing NUL where required). */
function asciiWithNul(value: string): Uint8Array {
  return new TextEncoder().encode(`${value}\0`);
}

/**
 * Import the UA (browser) public key as an ECDH public CryptoKey. `p256dh` is a
 * 65-byte uncompressed point; we split it into JWK x/y coordinates.
 */
async function importUaPublicKey(p256dh: Uint8Array): Promise<CryptoKey> {
  if (p256dh.length !== 65 || p256dh[0] !== 0x04) {
    throw new Error("UA p256dh must be a 65-byte uncompressed P-256 point");
  }
  const { bytesToBase64Url } = await import("./base64url");
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesToBase64Url(p256dh.subarray(1, 33)),
      y: bytesToBase64Url(p256dh.subarray(33, 65)),
      ext: true,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

/** Export an ECDH public key to the raw 65-byte uncompressed point. */
async function exportRawPublicKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return new Uint8Array(raw);
}

export interface EncryptDeps {
  /** Random bytes source (injectable for deterministic tests). */
  randomBytes?: (n: number) => Uint8Array;
  /** Ephemeral keypair generator (injectable for deterministic tests). */
  generateKeyPair?: () => Promise<CryptoKeyPair>;
}

/**
 * Encrypt a UTF-8 (or already-serialized) payload for a Web Push subscription.
 * Returns the full aes128gcm body ready to POST with
 * `Content-Encoding: aes128gcm`.
 */
export async function encryptWebPushPayload(
  payload: string | Uint8Array,
  keys: PushSubscriptionKeys,
  deps: EncryptDeps = {},
): Promise<EncryptResult> {
  const randomBytes =
    deps.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const generateKeyPair =
    deps.generateKeyPair ??
    (() =>
      crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ]) as Promise<CryptoKeyPair>);

  const plaintext = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;

  const uaPublicRaw = base64UrlToBytes(keys.p256dh);
  const authSecret = base64UrlToBytes(keys.auth);
  if (authSecret.length !== 16) {
    throw new Error("auth secret must be 16 bytes");
  }

  const uaPublicKey = await importUaPublicKey(uaPublicRaw);
  const asKeyPair = await generateKeyPair();
  const asPublicRaw = await exportRawPublicKey(asKeyPair.publicKey);

  // 1) ECDH shared secret.
  const ecdhBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaPublicKey },
    asKeyPair.privateKey,
    256,
  );
  const ecdhSecret = new Uint8Array(ecdhBits);

  // 2) PRK_key = HKDF(salt=auth, ikm=ecdh, info="WebPush: info\0"||ua||as, 32)
  const keyInfo = concatBytes(asciiWithNul("WebPush: info"), uaPublicRaw, asPublicRaw);
  const prkKey = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  // 3) Content salt + CEK + NONCE.
  const salt = randomBytes(16);
  const cek = await hkdf(salt, prkKey, asciiWithNul("Content-Encoding: aes128gcm"), 16);
  const nonce = await hkdf(salt, prkKey, asciiWithNul("Content-Encoding: nonce"), 12);

  // 4) Pad: single record → delimiter 0x02, then zero pad. We use no extra pad.
  const padded = concatBytes(plaintext, new Uint8Array([0x02]));

  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const cipherBuf = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce as BufferSource,
      tagLength: AES128GCM_TAG_BYTES * 8,
    },
    aesKey,
    padded as BufferSource,
  );
  const ciphertext = new Uint8Array(cipherBuf);

  // 5) aes128gcm header: salt(16) || rs(4 BE) || idlen(1) || keyid(as_public 65).
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, DEFAULT_RECORD_SIZE, false);
  const header = concatBytes(salt, rs, new Uint8Array([asPublicRaw.length]), asPublicRaw);

  return { body: concatBytes(header, ciphertext) };
}
