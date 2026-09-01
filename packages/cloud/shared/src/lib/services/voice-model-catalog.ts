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
} from "@elizaos/shared/local-inference/voice-models";

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
   * Fingerprints of the public keys corresponding to the signing keys in
   * the rotation window, exposed for downstream auditors. Informational:
   * the device-side updater does NOT read this field — it verifies
   * against its own configured public keys (`args.publicKeys` on
   * `verifyManifestSignatureText`), so rotation safety comes from the
   * device key list accepting both keys during the window, not from this
   * body-carried list. A key list carried inside a signed body can never
   * act as a trust root: any signer could self-authorize by listing its
   * own key. Base64 raw 32-byte keys. Values produced by
   * `fingerprintPublicKey` are canonical base64 encodings of raw
   * 32-byte keys; entries supplied through this field are passed
   * through unchanged.
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

/**
 * Decode a base64 credential, failing closed on malformed input.
 *
 * Surrounding whitespace is trimmed first — keys pasted from files
 * routinely carry a trailing newline — and a pure RFC 4648 §5 URL-safe
 * spelling (`-`/`_` throughout) is normalized to the standard alphabet
 * before validation: base64url is the same bytes in a standard alternate
 * encoding (JWK `d`, `basenc --base64url`, most JOSE tooling), not a
 * mistyped secret, and must keep working. A MIXED alphabet (standard
 * `+`/`/` and URL-safe `-`/`_` in the same credential) is rejected: no
 * standard tool emits one, and it is the signature of a hand-mangled
 * value. Any remaining character outside the canonical base64 alphabet
 * (including interior whitespace) throws instead of being silently
 * discarded by the lenient Buffer decoder: a corrupted or mistyped
 * signing secret must never decode to "some" bytes. Unpadded final
 * quanta are accepted (a legitimate spelling of the same bytes); a
 * final quantum whose discarded slack bits are non-zero (e.g. `AAB=`
 * where the canonical spelling is `AAA=`) and `=` padding anywhere but
 * the tail also throw.
 */
const CANONICAL_BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{2,3})?$/;

function decodeBase64Strict(input: string): Uint8Array {
  const trimmed = input.trim();
  const hasStandardAlphabetChars = /[+/]/.test(trimmed);
  const hasUrlSafeAlphabetChars = /[-_]/.test(trimmed);
  if (hasStandardAlphabetChars && hasUrlSafeAlphabetChars) {
    throw new Error(
      `Invalid base64: mixed alphabets (standard +// and URL-safe -/_ in the same credential) — no standard encoding emits both`,
    );
  }
  const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  if (!CANONICAL_BASE64.test(normalized)) {
    throw new Error(
      `Invalid base64: input contains characters outside the canonical base64 alphabet after trimming surrounding whitespace`,
    );
  }
  const bytes =
    typeof Buffer !== "undefined"
      ? new Uint8Array(Buffer.from(normalized, "base64"))
      : (() => {
          const bin = atob(normalized);
          const out = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          return out;
        })();
  // Reject non-zero slack bits: a final quantum like `AAB=` (canonical
  // `AAA=`) decodes to the same bytes only because its low bits are
  // discarded — a hand-mangled spelling, not an alternate encoding any
  // standard tool emits. Re-encoding the decoded bytes must reproduce
  // the input after restoring omitted padding.
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (encodeBase64(bytes) !== padded) {
    throw new Error(
      `Invalid base64: non-canonical final quantum (discarded slack bits are non-zero)`,
    );
  }
  return bytes;
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
