/**
 * Voice sub-model catalog service for Eliza Cloud (R5-versioning §3.1.1 +
 * §6.4).
 *
 * The runtime in-binary `VOICE_MODEL_VERSIONS` (re-exported from
 * `@elizaos/shared/local-inference/voice-models.js`) is the source of
 * truth at publish time; this service exposes it over the
 * `GET /api/v1/voice-models/catalog` endpoint with an Ed25519 signature
 * the device-side updater verifies before parsing.
 *
 * The signing key is loaded from the worker env:
 * - `ELIZA_VOICE_CATALOG_SIGNING_KEY_BASE64` (raw 32-byte Ed25519 secret
 *   key, base64-encoded). The publishing org rotates this on a
 *   two-release cycle (R5 §6.4) by publishing-with-both keys.
 * - `ELIZA_VOICE_CATALOG_NEXT_PUBLIC_KEY_BASE64` (optional rotation peer;
 *   exposed in the catalog so downstream auditors can verify the
 *   "next" public key matches a known release).
 *
 * Cache-Control: 15 minutes hard, 1 hour stale-while-revalidate. Voice
 * model rollouts don't need shorter, and matching the existing models
 * route keeps the CDN behavior predictable.
 */

import {
  VOICE_MODEL_VERSIONS,
  type VoiceModelVersion,
} from "@elizaos/shared";

/**
 * Wire shape returned by the catalog endpoint. The runtime updater reads
 * `versions[]` directly into its catalog-source pipeline.
 */
export interface VoiceModelCatalogResponse {
  /** Schema version of THIS endpoint, not the model versions. */
  readonly schema: "eliza-1-voice-models.v1";
  /** ISO timestamp the body was generated; the signature covers this. */
  readonly generatedAt: string;
  /** Stable copy of `VOICE_MODEL_VERSIONS`. */
  readonly versions: ReadonlyArray<VoiceModelVersion>;
  /**
   * Public-key fingerprints the device-side updater can pin against.
   * Base64 raw 32-byte keys. The runtime accepts ANY of these as a
   * signing key — used to manage rotation windows.
   */
  readonly publicKeyFingerprints: ReadonlyArray<string>;
}

/**
 * Build the body of the catalog response. Pure — easy to unit-test
 * outside the worker.
 */
export function buildVoiceModelCatalogBody(args: {
  now: Date;
  publicKeyFingerprints: ReadonlyArray<string>;
}): VoiceModelCatalogResponse {
  return {
    schema: "eliza-1-voice-models.v1",
    generatedAt: args.now.toISOString(),
    versions: VOICE_MODEL_VERSIONS,
    publicKeyFingerprints: args.publicKeyFingerprints,
  };
}

/**
 * Sign the body with Ed25519 (Node ≥ 24 / browsers since 2023). The body
 * passed in MUST be the exact bytes the response will return — JSON
 * round-trips lose whitespace and the verify-side hashes the raw text.
 *
 * Returns the base64-encoded 64-byte signature suitable for the
 * `X-Eliza-Signature` header.
 */
export async function signVoiceModelCatalog(args: {
  bodyText: string;
  secretKeyBase64: string;
}): Promise<string> {
  const secretRaw = decodeBase64Strict(args.secretKeyBase64);
  if (secretRaw.byteLength !== 32) {
    throw new Error(`Ed25519 secret key must be 32 bytes, got ${secretRaw.byteLength}`);
  }
  // Web Crypto's importKey requires the "pkcs8" or "jwk" format for
  // Ed25519 private keys. Wrap the raw 32-byte seed in a minimal PKCS8
  // envelope per RFC 8410.
  const pkcs8 = wrapEd25519SeedInPkcs8(secretRaw);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBufferView(pkcs8),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    key,
    toArrayBufferView(new TextEncoder().encode(args.bodyText)),
  );
  return encodeBase64(new Uint8Array(sig));
}

/** Compute the base64 fingerprint of a raw 32-byte Ed25519 public key. */
export function fingerprintPublicKey(rawPublicKeyBase64: string): string {
  const raw = decodeBase64Strict(rawPublicKeyBase64);
  if (raw.byteLength !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${raw.byteLength}`);
  }
  return encodeBase64(raw);
}

function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function decodeBase64Strict(input: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(input, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/**
 * Wrap a raw 32-byte Ed25519 seed in the minimal PKCS8 ASN.1 envelope per
 * RFC 8410 §7. Sequence-tagged byte sequence:
 *
 * 30 2E
 *   02 01 00              version: 0
 *   30 05
 *     06 03 2B 65 70      OID 1.3.101.112 (id-Ed25519)
 *   04 22                 OCTET STRING (34 bytes: prefix + 32-byte seed)
 *     04 20               OCTET STRING (32 bytes)
 *     <32 raw seed bytes>
 */
function wrapEd25519SeedInPkcs8(seed: Uint8Array): Uint8Array {
  if (seed.byteLength !== 32) {
    throw new Error(`Ed25519 seed must be 32 bytes`);
  }
  const prefix = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const out = new Uint8Array(prefix.length + seed.length);
  out.set(prefix, 0);
  out.set(seed, prefix.length);
  return out;
}
