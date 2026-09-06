/**
 * TOTP (RFC 6238) — time-based one-time passwords for authenticator-app 2FA.
 *
 * Uses HMAC-SHA-1 with a 30-second step, 6-digit codes (the configuration
 * universally accepted by Google Authenticator, Authy, 1Password, etc).
 *
 * Verification accepts the current step plus a configurable window of ±N
 * steps to tolerate clock skew between the user's device and the server.
 * The default window of ±1 step (so 90s total) is the recommendation from
 * the RFC for interactive 2FA.
 *
 * Secrets are stored as RFC 4648 base32 (uppercase, no padding) because
 * that is the format `otpauth://` URIs require and what authenticator apps
 * accept by scan or by hand-entry.
 */

const STEP_SEC = 30;
const DIGITS = 6;
const DEFAULT_WINDOW = 1;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const encoder = new TextEncoder();

/** RFC 4648 base32 encode (no padding). */
export function base32Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** RFC 4648 base32 decode. Tolerates lowercase, whitespace, and trailing '='. */
export function base32Decode(encoded: string): Uint8Array {
  const clean = encoded.toUpperCase().replace(/[\s=]/g, "");
  if (clean.length === 0) return new Uint8Array(0);
  for (const ch of clean) {
    if (!BASE32_ALPHABET.includes(ch)) {
      throw new Error("base32Decode: invalid character");
    }
  }
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let idx = 0;
  for (let i = 0; i < clean.length; i++) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(clean[i]);
    bits += 5;
    if (bits >= 8) {
      out[idx++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

/** Generate a fresh 20-byte (160-bit) secret and return it base32-encoded. */
export function generateTotpSecret(): string {
  const buf = new Uint8Array(20);
  crypto.getRandomValues(buf);
  return base32Encode(buf);
}

async function hmacSha1(
  key: Uint8Array,
  message: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.buffer.slice(
      key.byteOffset,
      key.byteOffset + key.byteLength,
    ) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    message.buffer.slice(
      message.byteOffset,
      message.byteOffset + message.byteLength,
    ) as ArrayBuffer,
  );
  return new Uint8Array(sig);
}

function counterToBytes(counter: number): Uint8Array {
  // 64-bit big-endian. Math.floor not bitwise — JS integers exceed 32 bits.
  const out = new Uint8Array(8);
  let n = Math.floor(counter);
  for (let i = 7; i >= 0; i--) {
    out[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return out;
}

function truncate(hmac: Uint8Array): number {
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return code % 10 ** DIGITS;
}

/** Generate the TOTP code for `secret` at `time` (defaults to Date.now()). */
export async function generateTotp(
  secret: string,
  options: { stepSec?: number; time?: number } = {},
): Promise<string> {
  const step = options.stepSec ?? STEP_SEC;
  const t = options.time ?? Date.now();
  const counter = Math.floor(t / 1000 / step);
  const key = base32Decode(secret);
  const hmac = await hmacSha1(key, counterToBytes(counter));
  return truncate(hmac).toString().padStart(DIGITS, "0");
}

export interface TotpVerifyOptions {
  /** ± steps of clock-skew tolerance. Default 1 (±30s). */
  windowSteps?: number;
  stepSec?: number;
  time?: number;
}

/**
 * Verify a user-supplied TOTP code. Returns `{ valid: true, drift }` where
 * `drift` is the step offset at which the code matched (0 = current step,
 * -1 = previous, +1 = next). Returns `{ valid: false }` on no match.
 *
 * Callers MUST track the per-secret highest-matched drift and reject any
 * subsequent code whose step <= the last accepted step — otherwise a code
 * captured in flight can be replayed within the same window.
 */
export async function verifyTotp(
  secret: string,
  code: string,
  options: TotpVerifyOptions = {},
): Promise<{ valid: boolean; drift?: number }> {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    return { valid: false };
  }
  const step = options.stepSec ?? STEP_SEC;
  const t = options.time ?? Date.now();
  const window = options.windowSteps ?? DEFAULT_WINDOW;
  const currentStep = Math.floor(t / 1000 / step);
  const key = base32Decode(secret);

  for (let drift = -window; drift <= window; drift++) {
    const hmac = await hmacSha1(key, counterToBytes(currentStep + drift));
    const expected = truncate(hmac).toString().padStart(DIGITS, "0");
    // Constant-time compare on the 6 digits.
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) {
      diff |= code.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    if (diff === 0) return { valid: true, drift };
  }
  return { valid: false };
}

export interface OtpauthUriParams {
  /** Application name shown in the authenticator app. */
  issuer: string;
  /** Account identifier (usually email or username). */
  accountName: string;
  /** Base32-encoded secret. */
  secret: string;
}

/**
 * Build the `otpauth://` URI consumed by authenticator-app QR codes.
 * Spec: https://github.com/google/google-authenticator/wiki/Key-Uri-Format
 */
export function buildOtpauthUri(params: OtpauthUriParams): string {
  const issuer = encodeURIComponent(params.issuer);
  const account = encodeURIComponent(params.accountName);
  const decodedSecret = base32Decode(params.secret);
  if (decodedSecret.length === 0)
    throw new Error("TOTP secret must contain base32 key material");
  const secret = base32Encode(decodedSecret);
  return (
    `otpauth://totp/${issuer}:${account}` +
    `?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SEC}`
  );
}

/**
 * Suppress unused-import warnings — `encoder` exists for parity with the
 * other auth modules even though TOTP doesn't itself encode UTF-8.
 */
export const _ = encoder;
