/**
 * Covers the confidential model-weights boot seam
 * (`prepareConfidentialModelWeights` and its streaming variant): the
 * `ELIZA_CONFIDENTIAL_WEIGHTS` flag gate, the fail-closed boot-gate refusal,
 * and happy-path in-memory unseal. Deterministic and hardware-free — a fixture
 * key-release client and locally sealed AES-256-GCM weights stand in for a real
 * KMS and attestation.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearTeeBootGateState,
  setTeeBootGateState,
} from "./tee-boot-gate-state.ts";
import type { SealedWeightsBlob } from "./tee-confidential-inference.ts";
import { sealModelWeightsShards } from "./tee-confidential-inference.ts";
import type {
  TeeKeyReleaseClient,
  TeeKeyReleaseRequest,
} from "./tee-key-release.ts";
import {
  CONFIDENTIAL_WEIGHTS_ENV,
  confidentialWeightsEnabled,
  prepareConfidentialModelWeights,
  prepareConfidentialModelWeightsStreaming,
} from "./tee-model-key-boot.ts";
import {
  evaluateTeeEvidencePolicy,
  type TeeEvidencePolicy,
} from "./tee-policy.ts";

const PLAINTEXT_WEIGHTS = Buffer.from(
  "eliza-1 confidential weights boot fixture",
  "utf8",
);
const WEIGHTS_SHA256 = createHash("sha256")
  .update(PLAINTEXT_WEIGHTS)
  .digest("hex");

const REQUIRED_MEASUREMENTS = [
  "agent",
  "policy",
  "container",
  "os",
  "npuFirmware",
  "modelWeights",
] as const;

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

function fixtureKeyReleaseClient(
  key: Buffer,
  evidence: unknown,
  onRelease?: () => void,
): TeeKeyReleaseClient {
  return {
    releaseKey: async (request: TeeKeyReleaseRequest) => {
      onRelease?.();
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

const ENABLED_ENV = { [CONFIDENTIAL_WEIGHTS_ENV]: "1" } as const;

describe("confidentialWeightsEnabled", () => {
  afterEach(() => clearTeeBootGateState());

  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["0", false],
    ["false", false],
    ["", false],
    [undefined, false],
  ])("env %s -> %s", (value, expected) => {
    expect(
      confidentialWeightsEnabled(
        value === undefined ? {} : { [CONFIDENTIAL_WEIGHTS_ENV]: value },
      ),
    ).toBe(expected);
  });
});

describe("prepareConfidentialModelWeights (boot seam)", () => {
  afterEach(() => clearTeeBootGateState());

  it("is inert and never releases a key when the flag is off", async () => {
    const key = randomBytes(32);
    let released = false;
    const result = await prepareConfidentialModelWeights({
      keyReleaseClient: fixtureKeyReleaseClient(key, trustedEvidence, () => {
        released = true;
      }),
      policy: policy(),
      sealedWeights: sealWith(key),
      requiredMeasurements: REQUIRED_MEASUREMENTS,
      env: {},
    });
    expect(result).toBeUndefined();
    expect(released).toBe(false);
  });

  it("unseals weights in memory on the happy path when enabled", async () => {
    const key = randomBytes(32);
    const result = await prepareConfidentialModelWeights({
      keyReleaseClient: fixtureKeyReleaseClient(key, trustedEvidence),
      policy: policy(),
      sealedWeights: sealWith(key),
      requiredMeasurements: REQUIRED_MEASUREMENTS,
      context: "eliza-1",
      env: ENABLED_ENV,
    });
    expect(result?.weights.equals(PLAINTEXT_WEIGHTS)).toBe(true);
    expect(result?.weightsSha256).toBe(WEIGHTS_SHA256);
    expect(result?.decision.trusted).toBe(true);
  });

  it("refuses (throws) when the boot gate already blocked secrets", async () => {
    setTeeBootGateState({
      policy: policy(),
      teeConfigured: true,
      required: true,
      productionProfile: false,
      secretsEnabled: false,
    });
    const key = randomBytes(32);
    let released = false;
    await expect(
      prepareConfidentialModelWeights({
        keyReleaseClient: fixtureKeyReleaseClient(key, trustedEvidence, () => {
          released = true;
        }),
        policy: policy(),
        sealedWeights: sealWith(key),
        requiredMeasurements: REQUIRED_MEASUREMENTS,
        env: ENABLED_ENV,
      }),
    ).rejects.toThrow(/TEE boot gate blocks secrets/);
    // The gate refuses before any key-release attempt.
    expect(released).toBe(false);
  });

  it("denies unseal (delegates fail-closed) when evidence is not trusted", async () => {
    const key = randomBytes(32);
    await expect(
      prepareConfidentialModelWeights({
        keyReleaseClient: fixtureKeyReleaseClient(key, {
          ...trustedEvidence,
          measurements: {
            ...trustedEvidence.measurements,
            agent: "sha256:tampered",
          },
        }),
        policy: policy(),
        sealedWeights: sealWith(key),
        requiredMeasurements: REQUIRED_MEASUREMENTS,
        env: ENABLED_ENV,
      }),
    ).rejects.toThrow(/model-key release denied/);
  });

  it("does not block secrets when a trusted boot gate is set", async () => {
    setTeeBootGateState({
      policy: policy(),
      teeConfigured: true,
      required: true,
      productionProfile: false,
      secretsEnabled: true,
    });
    const key = randomBytes(32);
    const result = await prepareConfidentialModelWeights({
      keyReleaseClient: fixtureKeyReleaseClient(key, trustedEvidence),
      policy: policy(),
      sealedWeights: sealWith(key),
      requiredMeasurements: REQUIRED_MEASUREMENTS,
      env: ENABLED_ENV,
    });
    expect(result?.weights.equals(PLAINTEXT_WEIGHTS)).toBe(true);
  });
});

describe("prepareConfidentialModelWeightsStreaming (boot seam)", () => {
  afterEach(() => clearTeeBootGateState());

  it("is inert and never invokes onShard when the flag is off", async () => {
    const key = randomBytes(32);
    const manifest = sealModelWeightsShards({
      weights: PLAINTEXT_WEIGHTS,
      key,
      shardSizeBytes: 8,
    });
    const calls: number[] = [];
    const result = await prepareConfidentialModelWeightsStreaming(
      {
        keyReleaseClient: fixtureKeyReleaseClient(key, trustedEvidence),
        policy: policy(),
        sealedWeights: manifest,
        requiredMeasurements: REQUIRED_MEASUREMENTS,
        env: {},
      },
      ({ index }) => {
        calls.push(index);
      },
    );
    expect(result).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("streams shards in order when enabled and trusted", async () => {
    const key = randomBytes(32);
    const manifest = sealModelWeightsShards({
      weights: PLAINTEXT_WEIGHTS,
      key,
      shardSizeBytes: 8,
    });
    const chunks: Buffer[] = [];
    const result = await prepareConfidentialModelWeightsStreaming(
      {
        keyReleaseClient: fixtureKeyReleaseClient(key, trustedEvidence),
        policy: policy(),
        sealedWeights: manifest,
        requiredMeasurements: REQUIRED_MEASUREMENTS,
        env: ENABLED_ENV,
      },
      ({ bytes }) => {
        chunks.push(Buffer.from(bytes));
      },
    );
    expect(result?.shardCount).toBe(manifest.shards.length);
    expect(Buffer.concat(chunks).equals(PLAINTEXT_WEIGHTS)).toBe(true);
  });

  it("refuses (throws) when the boot gate already blocked secrets", async () => {
    setTeeBootGateState({
      policy: policy(),
      teeConfigured: true,
      required: true,
      productionProfile: false,
      secretsEnabled: false,
    });
    const key = randomBytes(32);
    const manifest = sealModelWeightsShards({
      weights: PLAINTEXT_WEIGHTS,
      key,
      shardSizeBytes: 8,
    });
    const calls: number[] = [];
    await expect(
      prepareConfidentialModelWeightsStreaming(
        {
          keyReleaseClient: fixtureKeyReleaseClient(key, trustedEvidence),
          policy: policy(),
          sealedWeights: manifest,
          requiredMeasurements: REQUIRED_MEASUREMENTS,
          env: ENABLED_ENV,
        },
        ({ index }) => {
          calls.push(index);
        },
      ),
    ).rejects.toThrow(/TEE boot gate blocks secrets/);
    expect(calls).toEqual([]);
  });
});
