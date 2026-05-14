/**
 * Ed25519 signature verification for the Eliza Cloud voice-model catalog.
 *
 * Per R5-versioning §6.4: the catalog API JSON returned by Eliza Cloud is
 * signed with the elizaOS publishing key. The runtime auto-updater MUST
 * reject any catalog response whose signature does not verify before it
 * recommends any download. The public verification key is compiled into
 * the runtime binary; rotation is a two-release cycle (publish-with-both →
 * rotate-to-new → retire-old).
 *
 * Implementation uses Web Crypto's Ed25519 primitive (Node ≥ 24, browsers
 * since 2023). No vendor crypto dep — the runtime already targets Node 24+
 * (`packages/shared/package.json:"engines.node": ">=24.0.0"`).
 *
 * Spec: `.swarm/research/R5-versioning.md` §3.1 + §6.4.
 */

/**
 * Raw 32-byte Ed25519 public key, or a PEM/SPKI/JWK representation parsed
 * to a `CryptoKey` already. Most callers pass the raw 32-byte form because
 * that is how compile-time-embedded keys look.
 */
export type Ed25519PublicKey = Uint8Array | CryptoKey;

export interface SignatureVerifyInput {
  /** Raw response body bytes (UTF-8 encoded JSON or arbitrary bytes). */
  readonly body: Uint8Array;
  /**
   * Base64-encoded 64-byte Ed25519 signature, as it would arrive in an
   * HTTP header such as `X-Eliza-Signature`.
   */
  readonly signatureBase64: string;
  /**
   * One or more candidate public keys; the verify succeeds if ANY key
   * accepts. This is the rotation-window contract (current + next).
   */
  readonly publicKeys: ReadonlyArray<Ed25519PublicKey>;
}

export class ManifestSignatureError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ManifestSignatureError";
    this.code = code;
  }
}

const ED25519_ALGORITHM: AlgorithmIdentifier = { name: "Ed25519" };
const ED25519_PUBLIC_KEY_BYTES = 32 as const;
const ED25519_SIGNATURE_BYTES = 64 as const;

/**
 * Web Crypto's `BufferSource` signature in lib.dom.d.ts is now
 * `ArrayBufferView<ArrayBuffer>`, which **excludes** the generic
 * `Uint8Array<ArrayBufferLike>` we get from `atob` / `Buffer.from`
 * because those may be backed by `SharedArrayBuffer`. Materialise into
 * a fresh `ArrayBuffer`-backed `Uint8Array` at the API boundary.
 */
function toArrayBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function decodeBase64(input: string): Uint8Array {
  // Node 24+ ships Buffer; the browser ships `atob`. Prefer `Buffer.from`
  // when present because it is strict about padding; fall back to `atob`.
  if (typeof Buffer !== "undefined") {
    const buf = Buffer.from(input, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importRawEd25519PublicKey(
  raw: Uint8Array,
): Promise<CryptoKey> {
  if (raw.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
    throw new ManifestSignatureError(
      `Ed25519 public key must be ${ED25519_PUBLIC_KEY_BYTES} bytes, got ${raw.byteLength}`,
      "ELIZA_VOICE_PUBKEY_BAD_LENGTH",
    );
  }
  return crypto.subtle.importKey(
    "raw",
    toArrayBufferView(raw),
    ED25519_ALGORITHM,
    false,
    ["verify"],
  );
}

async function coerceKey(key: Ed25519PublicKey): Promise<CryptoKey> {
  if (key instanceof Uint8Array) return importRawEd25519PublicKey(key);
  return key;
}

/**
 * Verify `body` against `signatureBase64` using one or more Ed25519 public
 * keys. Returns the index of the first key that accepted the signature.
 * Throws `ManifestSignatureError` when no key accepts.
 *
 * The "accept any of N keys" contract is what makes signing-key rotation
 * safe — during rotation we ship both the current and next key, the
 * publisher signs with whichever it has access to, and the runtime accepts
 * either.
 */
export async function verifyManifestSignature(
  input: SignatureVerifyInput,
): Promise<number> {
  if (input.publicKeys.length === 0) {
    throw new ManifestSignatureError(
      "no public keys provided",
      "ELIZA_VOICE_PUBKEYS_EMPTY",
    );
  }
  let signature: Uint8Array;
  try {
    signature = decodeBase64(input.signatureBase64);
  } catch (err) {
    throw new ManifestSignatureError(
      `signature is not valid base64: ${String(err)}`,
      "ELIZA_VOICE_SIG_BASE64",
    );
  }
  if (signature.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new ManifestSignatureError(
      `Ed25519 signature must be ${ED25519_SIGNATURE_BYTES} bytes, got ${signature.byteLength}`,
      "ELIZA_VOICE_SIG_BAD_LENGTH",
    );
  }

  for (let i = 0; i < input.publicKeys.length; i++) {
    const candidate = input.publicKeys[i];
    if (candidate === undefined) continue;
    let cryptoKey: CryptoKey;
    try {
      cryptoKey = await coerceKey(candidate);
    } catch (err) {
      // A malformed key is a deployment bug, not an auth failure: surface
      // it so the operator notices. Skip to the next key — rotation still
      // works as long as ONE key is valid.
      if (err instanceof ManifestSignatureError) {
        // re-throw on the LAST key so the operator sees the misconfiguration
        if (i === input.publicKeys.length - 1) throw err;
        continue;
      }
      throw err;
    }
    const ok = await crypto.subtle.verify(
      ED25519_ALGORITHM,
      cryptoKey,
      toArrayBufferView(signature),
      toArrayBufferView(input.body),
    );
    if (ok) return i;
  }
  throw new ManifestSignatureError(
    "no candidate public key accepted the signature",
    "ELIZA_VOICE_SIG_REJECTED",
  );
}

/**
 * Convenience wrapper: encode a string body to UTF-8 bytes and verify. The
 * caller MUST pass the EXACT body bytes the server signed — JSON `.parse`
 * round-trips lose whitespace and would change the hash. The Cloud
 * endpoint at `cloud/apps/api/v1/voice-models/catalog/route.ts` signs the
 * serialized response body before sending; mirror that on the client by
 * verifying the raw response text before parsing.
 */
export async function verifyManifestSignatureText(
  body: string,
  signatureBase64: string,
  publicKeys: ReadonlyArray<Ed25519PublicKey>,
): Promise<number> {
  return verifyManifestSignature({
    body: new TextEncoder().encode(body),
    signatureBase64,
    publicKeys,
  });
}
