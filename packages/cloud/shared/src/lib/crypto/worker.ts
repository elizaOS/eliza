/**
 * Worker-safe byte encoding, SHA-256, and comparison primitives shared by
 * cloud authentication, signing, storage, and settlement domains.
 */

const UTF8 = new TextEncoder();
const HEX = "0123456789abcdef";

export type CryptoBytesInput = string | Uint8Array | ArrayBuffer;

export function utf8Bytes(value: string): Uint8Array {
  return UTF8.encode(value);
}

function ownedInputBytes(value: CryptoBytesInput): Uint8Array<ArrayBuffer> {
  const input =
    typeof value === "string"
      ? utf8Bytes(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  const owned = new Uint8Array(new ArrayBuffer(input.byteLength));
  owned.set(input);
  return owned;
}

export function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += HEX[byte >> 4] + HEX[byte & 15];
  }
  return output;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = (4 - (normalized.length % 4)) % 4;
  const binary = atob(`${normalized}${"=".repeat(padding)}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function stringToBase64Url(value: string): string {
  return bytesToBase64Url(utf8Bytes(value));
}

export async function sha256Bytes(value: CryptoBytesInput): Promise<Uint8Array<ArrayBuffer>> {
  const owned = ownedInputBytes(value);
  try {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", owned);
    return new Uint8Array(digest);
  } finally {
    owned.fill(0);
  }
}

export async function sha256Hex(value: CryptoBytesInput): Promise<string> {
  return bytesToHex(await sha256Bytes(value));
}

export async function sha256Base64Url(value: CryptoBytesInput): Promise<string> {
  return bytesToBase64Url(await sha256Bytes(value));
}

/**
 * Compares public-length byte strings without an early mismatch return. The
 * loop covers the longer input and folds length into the result; JavaScript
 * runtimes cannot promise CPU-level constant time, so callers must not treat
 * input length as secret.
 */
export function constantTimeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

/** UTF-8 comparison for signatures, digests, tokens, and other text secrets. */
export function constantTimeEqualUtf8(left: string, right: string): boolean {
  return constantTimeEqualBytes(utf8Bytes(left), utf8Bytes(right));
}
