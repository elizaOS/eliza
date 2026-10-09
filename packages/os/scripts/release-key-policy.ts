import { createHash, createPublicKey } from "node:crypto";

export const publicKeyEnvironment =
  "ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64";
export const publicKeyFingerprintEnvironment =
  "ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256";
export const revokedKeyFingerprintsEnvironment =
  "ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S";

export function canonicalBase64(value, label) {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error(`${label} must be canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error(`${label} must be canonical base64`);
  }
  return decoded;
}

export function canonicalFingerprint(value, label) {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{64}$/.test(value) ||
    value === "0".repeat(64)
  ) {
    throw new Error(`${label} must be a nonzero lowercase SHA-256 digest`);
  }
  return value;
}

export function revokedFingerprints(value) {
  if (value === undefined || value === "") return new Set();
  const fingerprints = value.split(",");
  const canonical = fingerprints.map((fingerprint) =>
    canonicalFingerprint(fingerprint, revokedKeyFingerprintsEnvironment),
  );
  if (
    new Set(canonical).size !== canonical.length ||
    [...canonical].sort().join(",") !== value
  ) {
    throw new Error(
      `${revokedKeyFingerprintsEnvironment} must be a sorted, unique comma-separated digest list`,
    );
  }
  return new Set(canonical);
}

export function loadReleaseKeyPolicy(env = process.env) {
  const key = createPublicKey({
    key: canonicalBase64(env[publicKeyEnvironment], publicKeyEnvironment),
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("release verification key must be Ed25519");
  }
  const publicKeyDer = key.export({ format: "der", type: "spki" });
  const publicKeyFingerprint = createHash("sha256")
    .update(publicKeyDer)
    .digest("hex");
  const expectedPublicKeyFingerprint = canonicalFingerprint(
    env[publicKeyFingerprintEnvironment],
    publicKeyFingerprintEnvironment,
  );
  if (publicKeyFingerprint !== expectedPublicKeyFingerprint) {
    throw new Error(
      "release verification key does not match the independently pinned SPKI SHA-256",
    );
  }
  if (
    revokedFingerprints(env[revokedKeyFingerprintsEnvironment]).has(
      publicKeyFingerprint,
    )
  ) {
    throw new Error("release verification key is revoked");
  }
  return { key, publicKeyDer, publicKeyFingerprint };
}
