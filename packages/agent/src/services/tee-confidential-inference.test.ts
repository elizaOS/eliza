import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type SealedWeightsBlob,
  unsealModelWeights,
} from "./tee-confidential-inference.ts";
import type {
  TeeKeyReleaseClient,
  TeeKeyReleaseRequest,
} from "./tee-key-release.ts";
import {
  evaluateTeeEvidencePolicy,
  type TeeEvidencePolicy,
} from "./tee-policy.ts";

const PLAINTEXT_WEIGHTS = Buffer.from(
  "eliza-1 confidential weights fixture payload",
  "utf8",
);
const WEIGHTS_SHA256 = createHash("sha256")
  .update(PLAINTEXT_WEIGHTS)
  .digest("hex");

const trustedEvidence = {
  kind: "tdx",
  provider: "dstack",
  hardwareVendor: "intel",
  securityVersion: 7,
  measurements: {
    agent: "sha256:agent",
    policy: "sha256:policy",
    container: "sha256:container",
    os: "sha256:os",
    npuFirmware: "sha256:npufw",
    modelWeights: `sha256:${WEIGHTS_SHA256}`,
  },
  freshness: {
    nonce: "n1",
    timestamp: "2026-05-20T12:00:00.000Z",
    verifier: "intel-pcs",
  },
  claims: {
    debugDisabled: true,
    secureBoot: true,
    memoryEncrypted: true,
    ioProtected: true,
    productionLifecycle: true,
    npuProtected: true,
  },
};

const REQUIRED_MEASUREMENTS = [
  "agent",
  "policy",
  "container",
  "os",
  "npuFirmware",
  "modelWeights",
] as const;

function policy(): TeeEvidencePolicy {
  return {
    required: true,
    allowedKinds: ["tdx"],
    nowMs: Date.parse("2026-05-20T12:00:05.000Z"),
    maxAgeMs: 60_000,
    requiredMeasurements: {
      agent: "sha256:agent",
      policy: "sha256:policy",
      container: "sha256:container",
      os: "sha256:os",
      npuFirmware: "sha256:npufw",
      modelWeights: `sha256:${WEIGHTS_SHA256}`,
    },
    requiredClaims: { debugDisabled: true, npuProtected: true },
  };
}

function sealWith(key: Buffer): SealedWeightsBlob {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(PLAINTEXT_WEIGHTS),
    cipher.final(),
  ]);
  return {
    algorithm: "aes-256-gcm",
    ivBase64: iv.toString("base64"),
    authTagBase64: cipher.getAuthTag().toString("base64"),
    ciphertextBase64: ciphertext.toString("base64"),
    weightsSha256: WEIGHTS_SHA256,
  };
}

/**
 * Fixture KMS: returns a fixed 32-byte key when the evidence satisfies the
 * policy, mirroring a real attestation-gated `model-key` release. Real quote
 * verification is BLOCKED on hardware — this exercises the unseal plumbing only.
 */
function fixtureKeyReleaseClient(
  key: Buffer,
  evidence: unknown,
): TeeKeyReleaseClient {
  return {
    releaseKey: async (request: TeeKeyReleaseRequest) => {
      const decision = evaluateTeeEvidencePolicy(evidence, request.policy);
      if (!decision.trusted) {
        return { keyId: request.keyId, keyMaterialHex: "", decision };
      }
      return {
        keyId: request.keyId,
        keyMaterialHex: key.toString("hex"),
        decision,
      };
    },
  };
}

describe("TEE confidential-inference unseal", () => {
  it("releases model-key and decrypts weights in memory on the happy path", async () => {
    const key = randomBytes(32);
    const sealed = sealWith(key);
    const result = await unsealModelWeights({
      keyReleaseClient: fixtureKeyReleaseClient(key, trustedEvidence),
      policy: policy(),
      sealedWeights: sealed,
      requiredMeasurements: REQUIRED_MEASUREMENTS,
      context: "eliza-1",
    });
    expect(result.weights.equals(PLAINTEXT_WEIGHTS)).toBe(true);
    expect(result.weightsSha256).toBe(WEIGHTS_SHA256);
    expect(result.decision.trusted).toBe(true);
  });

  it("denies unseal (weights stay sealed) when evidence is not trusted", async () => {
    const key = randomBytes(32);
    const sealed = sealWith(key);
    await expect(
      unsealModelWeights({
        keyReleaseClient: fixtureKeyReleaseClient(key, {
          ...trustedEvidence,
          measurements: {
            ...trustedEvidence.measurements,
            agent: "sha256:tampered",
          },
        }),
        policy: policy(),
        sealedWeights: sealed,
        requiredMeasurements: REQUIRED_MEASUREMENTS,
      }),
    ).rejects.toThrow(/model-key release denied/);
  });

  it("refuses when the policy does not gate every required measurement", async () => {
    const key = randomBytes(32);
    const sealed = sealWith(key);
    const weakPolicy = policy();
    delete weakPolicy.requiredMeasurements?.npuFirmware;
    await expect(
      unsealModelWeights({
        keyReleaseClient: fixtureKeyReleaseClient(key, trustedEvidence),
        policy: weakPolicy,
        sealedWeights: sealed,
        requiredMeasurements: REQUIRED_MEASUREMENTS,
      }),
    ).rejects.toThrow(/does not gate required measurements: npuFirmware/);
  });

  it("refuses when the sealed weights digest does not match the policy binding", async () => {
    const key = randomBytes(32);
    const sealed = sealWith(key);
    await expect(
      unsealModelWeights({
        keyReleaseClient: fixtureKeyReleaseClient(key, trustedEvidence),
        policy: policy(),
        sealedWeights: { ...sealed, weightsSha256: "f".repeat(64) },
        requiredMeasurements: REQUIRED_MEASUREMENTS,
      }),
    ).rejects.toThrow(/modelWeights digest does not match/);
  });

  it("fails closed (auth-tag) when the released key is wrong", async () => {
    const sealed = sealWith(randomBytes(32));
    const wrongKey = randomBytes(32);
    await expect(
      unsealModelWeights({
        keyReleaseClient: fixtureKeyReleaseClient(wrongKey, trustedEvidence),
        policy: policy(),
        sealedWeights: sealed,
        requiredMeasurements: REQUIRED_MEASUREMENTS,
      }),
    ).rejects.toThrow();
  });
});
