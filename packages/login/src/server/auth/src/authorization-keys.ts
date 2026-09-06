/**
 * P-256 (secp256r1 / ECDSA) asymmetric authorization keys.
 *
 * Privy "authorization keys" are P-256 keypairs: the client signs each
 * privileged request with a private key and the server verifies the signature
 * against a registered public key. This module is the asymmetric counterpart to
 * the symmetric HMAC request-signing path in
 * `packages/api/src/middleware/authorization-signature.ts`.
 *
 * The verifier signs/verifies the SAME canonical string the HMAC path builds,
 * so the two mechanisms are interchangeable per signer record.
 *
 * Security posture: every parse / import / verify error is swallowed and
 * surfaced as `false` (fail closed). No exception escapes `verifyP256Signature`.
 *
 * ── Accepted public-key encodings ──────────────────────────────────────────
 *   - SPKI / DER, base64 or base64url (the standard `crypto.subtle` "spki"
 *     export — what `exportP256PublicKeySpkiBase64` emits).
 *   - Raw uncompressed EC point `0x04 || X(32) || Y(32)` (65 bytes), as base64,
 *     base64url, or hex (with or without a leading `0x`). WebCrypto imports this
 *     via the "raw" format.
 *   - JWK (an object, or a JSON string) with `kty:"EC"`, `crv:"P-256"`.
 *
 * ── Accepted signature encodings ───────────────────────────────────────────
 *   - IEEE-P1363 fixed-width `r || s` (64 bytes for P-256), base64/base64url/hex.
 *     This is what WebCrypto's ECDSA verify expects natively and what
 *     `signP256` emits.
 *   - ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }` (what OpenSSL / many HSMs
 *     emit), base64/base64url/hex. Converted to r||s before verification;
 *     malformed DER fails closed.
 */

const P256_CURVE = "P-256";
const P256_COORD_BYTES = 32;
const P256_RAW_POINT_BYTES = 1 + P256_COORD_BYTES * 2; // 0x04 || X || Y
const P256_P1363_SIG_BYTES = P256_COORD_BYTES * 2; // r || s

const ECDSA_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const;
const EC_KEY_IMPORT_PARAMS = { name: "ECDSA", namedCurve: P256_CURVE } as const;

export type P256PublicKeyInput = string | JsonWebKey | CryptoKey;

// ── byte / encoding helpers ────────────────────────────────────────────────

function base64ToBytes(value: string): Uint8Array | null {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  let paddingStart = normalized.length;
  while (paddingStart > 0 && normalized.charCodeAt(paddingStart - 1) === 0x3d)
    paddingStart -= 1;
  const trimmed = normalized.slice(0, paddingStart);
  // Reject anything that is not valid base64 alphabet so a hex/garbage string
  // doesn't get silently mangled by atob.
  if (!/^[A-Za-z0-9+/]*$/.test(trimmed)) return null;
  const padded = trimmed.padEnd(
    trimmed.length + ((4 - (trimmed.length % 4)) % 4),
    "=",
  );
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function hexToBytes(value: string): Uint8Array | null {
  const stripped =
    value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  if (stripped.length === 0 || stripped.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(stripped)) return null;
  const bytes = new Uint8Array(stripped.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Decode a string that may be hex (with/without 0x) or base64/base64url into
 * CANDIDATE byte decodings, most-likely first.
 *
 * Every even-length bare-hex string is also valid base64 alphabet, so a single
 * decode is ambiguous (SEC-063): decoding base64-first makes documented
 * bare-hex encodings unreachable, and decoding hex-first would misread
 * all-hex-alphabet base64. Callers must therefore try each candidate in order
 * and keep the first whose bytes actually import/normalize — the format check
 * downstream disambiguates, and every failure still fails closed.
 */
function decodeFlexibleCandidates(value: string): Uint8Array[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
    const hex = hexToBytes(trimmed);
    return hex ? [hex] : [];
  }
  const candidates: Uint8Array[] = [];
  const asBase64 = base64ToBytes(trimmed);
  if (asBase64) candidates.push(asBase64);
  const asHex = hexToBytes(trimmed);
  if (
    asHex &&
    (!asBase64 ||
      asHex.length !== asBase64.length ||
      asHex.some((byte, index) => byte !== asBase64[index]))
  ) {
    candidates.push(asHex);
  }
  return candidates;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

// ── DER → P1363 signature conversion ───────────────────────────────────────

/**
 * Convert an ASN.1 DER ECDSA signature `SEQUENCE { INTEGER r, INTEGER s }` to
 * fixed-width `r || s` (each `P256_COORD_BYTES`). Returns null on malformed
 * input or out-of-range integers (fail closed).
 */
function derToP1363(der: Uint8Array): Uint8Array | null {
  let offset = 0;
  if (der[offset++] !== 0x30) return null; // SEQUENCE
  // Sequence length (short or long form).
  let seqLen = der[offset++];
  if (seqLen === undefined) return null;
  if (seqLen & 0x80) {
    const numBytes = seqLen & 0x7f;
    if (numBytes < 1 || numBytes > 2) return null;
    seqLen = 0;
    for (let i = 0; i < numBytes; i += 1) {
      const b = der[offset++];
      if (b === undefined) return null;
      seqLen = (seqLen << 8) | b;
    }
  }
  if (offset + seqLen !== der.length) return null;

  const readInt = (): Uint8Array | null => {
    if (der[offset++] !== 0x02) return null; // INTEGER
    const len = der[offset++];
    if (len === undefined || len === 0 || offset + len > der.length)
      return null;
    let value = der.subarray(offset, offset + len);
    offset += len;
    // Strip a single leading 0x00 used to keep the integer positive.
    if (value.length > 1 && value[0] === 0x00) value = value.subarray(1);
    if (value.length > P256_COORD_BYTES) return null; // out of range
    return value;
  };

  const r = readInt();
  const s = readInt();
  if (!r || !s || offset !== der.length) return null;

  const out = new Uint8Array(P256_P1363_SIG_BYTES);
  out.set(r, P256_COORD_BYTES - r.length);
  out.set(s, P256_P1363_SIG_BYTES - s.length);
  return out;
}

/**
 * Normalize an incoming signature to fixed-width `r || s` bytes. Accepts both
 * P1363 (returned as-is) and DER (converted). Returns null when the bytes are
 * neither a valid 64-byte P1363 signature nor decodable DER.
 */
function normalizeSignatureBytes(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length === P256_P1363_SIG_BYTES) return bytes;
  // Heuristic: DER signatures start with the SEQUENCE tag 0x30.
  if (bytes[0] === 0x30) return derToP1363(bytes);
  return null;
}

// ── public-key import ──────────────────────────────────────────────────────

function looksLikeJwk(value: unknown): value is JsonWebKey {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kty?: unknown }).kty === "EC" &&
    (value as { crv?: unknown }).crv === P256_CURVE
  );
}

/**
 * Import a P-256 public key from any accepted encoding. Returns null on any
 * failure (wrong curve, wrong format, malformed bytes) — fail closed.
 *
 * Exported so callers can pre-validate a registered key at write time.
 */
export async function importP256PublicKey(
  input: P256PublicKeyInput,
): Promise<CryptoKey | null> {
  try {
    if (input instanceof CryptoKey) {
      if (input.type !== "public") return null;
      const alg = input.algorithm as EcKeyAlgorithm;
      if (alg?.name !== "ECDSA" || alg?.namedCurve !== P256_CURVE) return null;
      return input;
    }

    // JWK passed as an object.
    if (typeof input === "object" && input !== null) {
      if (!looksLikeJwk(input)) return null;
      return await crypto.subtle.importKey(
        "jwk",
        input,
        EC_KEY_IMPORT_PARAMS,
        false,
        ["verify"],
      );
    }

    const text = input.trim();
    if (!text) return null;

    // JWK passed as a JSON string.
    if (text.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }
      if (!looksLikeJwk(parsed)) return null;
      return await crypto.subtle.importKey(
        "jwk",
        parsed,
        EC_KEY_IMPORT_PARAMS,
        false,
        ["verify"],
      );
    }

    const candidates = decodeFlexibleCandidates(text);
    for (const bytes of candidates) {
      // Raw uncompressed EC point: 0x04 || X || Y.
      if (bytes.length === P256_RAW_POINT_BYTES && bytes[0] === 0x04) {
        const key = await crypto.subtle
          .importKey("raw", toArrayBuffer(bytes), EC_KEY_IMPORT_PARAMS, false, [
            "verify",
          ])
          .catch(() => null);
        if (key) return key;
        continue;
      }

      // Otherwise treat as SPKI/DER. importKey enforces the curve, so a P-384 /
      // secp256k1 SPKI blob is rejected here (fail closed) because namedCurve
      // mismatches.
      const key = await crypto.subtle
        .importKey("spki", toArrayBuffer(bytes), EC_KEY_IMPORT_PARAMS, false, [
          "verify",
        ])
        .catch(() => null);
      if (key) return key;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Verify a P-256 ECDSA signature over `canonicalString`.
 *
 * @param publicKey   Registered public key in any accepted encoding (see module docs).
 * @param canonicalString  The exact canonical request string the signer signed.
 * @param signatureBase64  Signature as base64/base64url/hex, P1363 r||s or DER.
 * @returns `true` only on a cryptographically valid signature; `false` on ANY
 *          error (import failure, wrong curve, malformed signature, mismatch).
 */
export async function verifyP256Signature(
  publicKey: P256PublicKeyInput,
  canonicalString: string,
  signatureBase64: string,
): Promise<boolean> {
  try {
    if (
      typeof signatureBase64 !== "string" ||
      typeof canonicalString !== "string"
    )
      return false;
    const key = await importP256PublicKey(publicKey);
    if (!key) return false;

    // Try each decoding candidate (base64 vs bare-hex ambiguity, SEC-063)
    // until one normalizes to a fixed-width r||s signature.
    const normalized = decodeFlexibleCandidates(signatureBase64)
      .map((bytes) => normalizeSignatureBytes(bytes))
      .find((bytes) => bytes !== null);
    if (!normalized) return false;

    const data = new TextEncoder().encode(canonicalString);
    return await crypto.subtle.verify(
      ECDSA_PARAMS,
      key,
      toArrayBuffer(normalized),
      toArrayBuffer(data),
    );
  } catch {
    return false;
  }
}

// ── test / tooling helpers ─────────────────────────────────────────────────

export type GeneratedP256KeyPair = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  /** Base64 SPKI public key, suitable for storing as `agent_signers.public_key`. */
  publicKeySpkiBase64: string;
  /** Base64 raw uncompressed `04||X||Y` public key. */
  publicKeyRawBase64: string;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1)
    binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Generate a P-256 keypair (extractable public key) for tests / tooling. */
export async function generateP256KeyPair(): Promise<GeneratedP256KeyPair> {
  const pair = (await crypto.subtle.generateKey(EC_KEY_IMPORT_PARAMS, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeySpkiBase64: bytesToBase64(spki),
    publicKeyRawBase64: bytesToBase64(raw),
  };
}

/** Export a P-256 public key to base64 SPKI (storage format). */
export async function exportP256PublicKeySpkiBase64(
  publicKey: CryptoKey,
): Promise<string> {
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  return bytesToBase64(spki);
}

/**
 * Sign `canonicalString` with a P-256 private key, returning a base64 P1363
 * (r||s) signature. For tests / client tooling only.
 */
export async function signP256(
  privateKey: CryptoKey,
  canonicalString: string,
): Promise<string> {
  const data = new TextEncoder().encode(canonicalString);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      ECDSA_PARAMS,
      privateKey,
      data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer,
    ),
  );
  return bytesToBase64(signature);
}
