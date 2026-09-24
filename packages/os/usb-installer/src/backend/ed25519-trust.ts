// Ed25519 trust primitives shared by release-manifest and image verification.
import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify,
} from "node:crypto";

export const RELEASE_PUBLIC_KEY_ENV =
  "ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64";
export const RELEASE_PUBLIC_KEY_FINGERPRINT_ENV =
  "ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256";
export const RELEASE_REVOKED_KEY_FINGERPRINTS_ENV =
  "ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S";
export const RELEASE_PUBLIC_KEY_BUILD_DEFINE =
  "__ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64__";
declare const __ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64__:
  | string
  | undefined;
declare const __ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256__:
  | string
  | undefined;
declare const __ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S__:
  | string
  | undefined;
const ED25519_SIGNATURE_BYTES = 64;

function decodeStrictBase64(value: string, label: string): Buffer {
  const compact = value.trim();
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      compact,
    )
  ) {
    throw new Error(`${label} must be canonical base64.`);
  }
  const decoded = Buffer.from(compact, "base64");
  if (decoded.toString("base64") !== compact) {
    throw new Error(`${label} must be canonical base64.`);
  }
  return decoded;
}

function canonicalFingerprint(
  value: string | undefined,
  label: string,
): string {
  if (!value || !/^[a-f0-9]{64}$/.test(value) || value === "0".repeat(64)) {
    throw new Error(`${label} must be a nonzero lowercase SHA-256 digest.`);
  }
  return value;
}

function revokedFingerprints(value: string | undefined): Set<string> {
  if (value === undefined || value === "") return new Set();
  const fingerprints = value
    .split(",")
    .map((fingerprint) =>
      canonicalFingerprint(fingerprint, RELEASE_REVOKED_KEY_FINGERPRINTS_ENV),
    );
  if (
    new Set(fingerprints).size !== fingerprints.length ||
    [...fingerprints].sort().join(",") !== value
  ) {
    throw new Error(
      `${RELEASE_REVOKED_KEY_FINGERPRINTS_ENV} must be a sorted, unique comma-separated digest list.`,
    );
  }
  return new Set(fingerprints);
}

export function loadPinnedEd25519PublicKey(
  env: NodeJS.ProcessEnv = process.env,
): KeyObject {
  const compiledKey =
    typeof __ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64__ === "string"
      ? __ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64__
      : undefined;
  const compiledFingerprint =
    typeof __ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256__ === "string"
      ? __ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256__
      : undefined;
  const compiledRevocations =
    typeof __ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S__ ===
    "string"
      ? __ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S__
      : undefined;
  const encoded = compiledKey ?? env[RELEASE_PUBLIC_KEY_ENV];
  if (!encoded) {
    throw new Error(
      `Missing pinned release key: ${RELEASE_PUBLIC_KEY_ENV} is required. Production release discovery is disabled.`,
    );
  }
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: decodeStrictBase64(encoded, RELEASE_PUBLIC_KEY_ENV),
      format: "der",
      type: "spki",
    });
  } catch (error) {
    throw new Error(`Invalid pinned Ed25519 release key: ${String(error)}`);
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Pinned release key must be an Ed25519 SPKI public key.");
  }
  const fingerprint = publicKeyFingerprint(key);
  const expectedFingerprint = canonicalFingerprint(
    compiledKey ? compiledFingerprint : env[RELEASE_PUBLIC_KEY_FINGERPRINT_ENV],
    RELEASE_PUBLIC_KEY_FINGERPRINT_ENV,
  );
  if (fingerprint !== expectedFingerprint) {
    throw new Error(
      "Pinned release key does not match the independently reviewed SPKI SHA-256.",
    );
  }
  if (
    revokedFingerprints(
      compiledKey
        ? compiledRevocations
        : env[RELEASE_REVOKED_KEY_FINGERPRINTS_ENV],
    ).has(fingerprint)
  ) {
    throw new Error("Pinned release key is revoked.");
  }
  return key;
}

export function decodeDetachedEd25519Signature(bytes: Uint8Array): Buffer {
  if (bytes.byteLength === ED25519_SIGNATURE_BYTES) return Buffer.from(bytes);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  const decoded = decodeStrictBase64(text, "Detached Ed25519 signature");
  if (decoded.byteLength !== ED25519_SIGNATURE_BYTES) {
    throw new Error(
      "Detached Ed25519 signature must decode to exactly 64 bytes.",
    );
  }
  return decoded;
}

export function assertEd25519Signature(
  data: Uint8Array,
  signatureBytes: Uint8Array,
  publicKey: KeyObject,
  label: string,
): void {
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`${label} verification requires an Ed25519 public key.`);
  }
  const signature = decodeDetachedEd25519Signature(signatureBytes);
  if (!verify(null, data, publicKey, signature)) {
    throw new Error(`${label} Ed25519 signature verification failed.`);
  }
}

export function publicKeyFingerprint(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  return createHash("sha256").update(der).digest("hex");
}
