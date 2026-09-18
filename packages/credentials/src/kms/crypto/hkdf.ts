/**
 * HKDF-SHA256 derivation primitive used by KMS adapters to derive scoped subkeys.
 */

import { hkdfSync } from "node:crypto";

/**
 * HKDF-SHA256. Returns `length` bytes derived from `ikm` with optional salt and info.
 * Used by adapters to derive sub-keys (e.g. per-version DEKs from a single Steward-held root).
 */
export function hkdfSha256(
  ikm: Uint8Array,
  length: number,
  info: Uint8Array = new Uint8Array(0),
  salt: Uint8Array = new Uint8Array(0),
): Uint8Array {
  if (length <= 0 || length > 255 * 32) {
    throw new Error(`hkdf length out of range: ${length}`);
  }
  const out = hkdfSync(
    "sha256",
    Buffer.from(ikm),
    Buffer.from(salt),
    Buffer.from(info),
    length,
  );
  return new Uint8Array(out as ArrayBuffer);
}
