import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type SealedWeightsBlob,
  sealModelWeightsShards,
  unsealModelWeights,
  unsealModelWeightsStreaming,
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
    // `npuFirmware` is owned by the NPU private-inference gate (see
    // tee-npu-gate.test.ts); drop `container` here to exercise the generic
    // required-measurements gate.
    delete weakPolicy.requiredMeasurements?.container;
    await expect(
      unsealModelWeights({
        keyReleaseClient: fixtureKeyReleaseClient(key, trustedEvidence),
        policy: weakPolicy,
        sealedWeights: sealed,
        requiredMeasurements: REQUIRED_MEASUREMENTS,
      }),
    ).rejects.toThrow(/does not gate required measurements: container/);
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

// A multi-shard plaintext large enough to span several shards (7 bytes each ->
// 7 shards, the last partial), so ordering and reassembly are exercised.
const SHARDED_WEIGHTS = Buffer.from(
  "eliza-1 confidential per-shard weights streaming fixture payload!",
  "utf8",
);
const SHARDED_SHA256 = createHash("sha256")
  .update(SHARDED_WEIGHTS)
  .digest("hex");
const SHARD_SIZE = 7;

function shardPolicy(): TeeEvidencePolicy {
  const p = policy();
  if (p.requiredMeasurements) {
    p.requiredMeasurements.modelWeights = `sha256:${SHARDED_SHA256}`;
  }
  return p;
}

function shardEvidence() {
  return {
    ...trustedEvidence,
    measurements: {
      ...trustedEvidence.measurements,
      modelWeights: `sha256:${SHARDED_SHA256}`,
    },
  };
}

describe("TEE confidential-inference streaming per-shard unseal", () => {
  it("round-trips a multi-shard blob in order with one onShard call per shard", async () => {
    const key = randomBytes(32);
    const manifest = sealModelWeightsShards({
      weights: SHARDED_WEIGHTS,
      key,
      shardSizeBytes: SHARD_SIZE,
    });
    const expectedShardCount = Math.ceil(SHARDED_WEIGHTS.length / SHARD_SIZE);
    expect(manifest.shards.length).toBe(expectedShardCount);

    const seenIndices: number[] = [];
    const chunks: Buffer[] = [];
    const result = await unsealModelWeightsStreaming(
      {
        keyReleaseClient: fixtureKeyReleaseClient(key, shardEvidence()),
        policy: shardPolicy(),
        sealedWeights: manifest,
        requiredMeasurements: REQUIRED_MEASUREMENTS,
        context: "eliza-1",
      },
      ({ index, bytes }) => {
        seenIndices.push(index);
        // The buffer is zeroized after onShard returns, so copy what we keep.
        chunks.push(Buffer.from(bytes));
      },
    );

    expect(seenIndices).toEqual(
      Array.from({ length: expectedShardCount }, (_, i) => i),
    );
    expect(Buffer.concat(chunks).equals(SHARDED_WEIGHTS)).toBe(true);
    expect(result.weightsSha256).toBe(SHARDED_SHA256);
    expect(result.shardCount).toBe(expectedShardCount);
    expect(result.decision.trusted).toBe(true);
  });

  it("zeroizes each shard buffer after onShard returns", async () => {
    const key = randomBytes(32);
    const manifest = sealModelWeightsShards({
      weights: SHARDED_WEIGHTS,
      key,
      shardSizeBytes: SHARD_SIZE,
    });
    const handed: Buffer[] = [];
    await unsealModelWeightsStreaming(
      {
        keyReleaseClient: fixtureKeyReleaseClient(key, shardEvidence()),
        policy: shardPolicy(),
        sealedWeights: manifest,
        requiredMeasurements: REQUIRED_MEASUREMENTS,
      },
      ({ bytes }) => {
        handed.push(bytes);
      },
    );
    // Every buffer handed to the sink is wiped once the loop advances past it.
    for (const buf of handed) {
      expect(buf.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("fails closed when a shard ciphertext is tampered", async () => {
    const key = randomBytes(32);
    const manifest = sealModelWeightsShards({
      weights: SHARDED_WEIGHTS,
      key,
      shardSizeBytes: SHARD_SIZE,
    });
    const target = manifest.shards[2];
    const tampered = Buffer.from(target.ciphertextBase64, "base64");
    tampered[0] ^= 0xff;
    const tamperedManifest = {
      ...manifest,
      shards: manifest.shards.map((s) =>
        s.index === 2
          ? { ...s, ciphertextBase64: tampered.toString("base64") }
          : s,
      ),
    };
    await expect(
      unsealModelWeightsStreaming(
        {
          keyReleaseClient: fixtureKeyReleaseClient(key, shardEvidence()),
          policy: shardPolicy(),
          sealedWeights: tamperedManifest,
          requiredMeasurements: REQUIRED_MEASUREMENTS,
        },
        () => {},
      ),
    ).rejects.toThrow();
  });

  it("fails closed (auth-tag) when the released key is wrong", async () => {
    const manifest = sealModelWeightsShards({
      weights: SHARDED_WEIGHTS,
      key: randomBytes(32),
      shardSizeBytes: SHARD_SIZE,
    });
    await expect(
      unsealModelWeightsStreaming(
        {
          keyReleaseClient: fixtureKeyReleaseClient(
            randomBytes(32),
            shardEvidence(),
          ),
          policy: shardPolicy(),
          sealedWeights: manifest,
          requiredMeasurements: REQUIRED_MEASUREMENTS,
        },
        () => {},
      ),
    ).rejects.toThrow();
  });

  it("fails closed when the manifest weightsSha256 does not match the reassembly", async () => {
    const key = randomBytes(32);
    const manifest = sealModelWeightsShards({
      weights: SHARDED_WEIGHTS,
      key,
      shardSizeBytes: SHARD_SIZE,
    });
    // Corrupt only the manifest-level digest; shard plaintext digests still pass,
    // so this isolates the running-digest defense-in-depth check.
    const mismatched = { ...manifest, weightsSha256: "a".repeat(64) };
    const p = shardPolicy();
    if (p.requiredMeasurements) {
      p.requiredMeasurements.modelWeights = `sha256:${"a".repeat(64)}`;
    }
    const evidence = {
      ...shardEvidence(),
      measurements: {
        ...shardEvidence().measurements,
        modelWeights: `sha256:${"a".repeat(64)}`,
      },
    };
    await expect(
      unsealModelWeightsStreaming(
        {
          keyReleaseClient: fixtureKeyReleaseClient(key, evidence),
          policy: p,
          sealedWeights: mismatched,
          requiredMeasurements: REQUIRED_MEASUREMENTS,
        },
        () => {},
      ),
    ).rejects.toThrow(/Reassembled model weights digest does not match/);
  });

  it("denies streaming unseal when evidence is not trusted", async () => {
    const key = randomBytes(32);
    const manifest = sealModelWeightsShards({
      weights: SHARDED_WEIGHTS,
      key,
      shardSizeBytes: SHARD_SIZE,
    });
    const calls: number[] = [];
    await expect(
      unsealModelWeightsStreaming(
        {
          keyReleaseClient: fixtureKeyReleaseClient(key, {
            ...shardEvidence(),
            measurements: {
              ...shardEvidence().measurements,
              agent: "sha256:tampered",
            },
          }),
          policy: shardPolicy(),
          sealedWeights: manifest,
          requiredMeasurements: REQUIRED_MEASUREMENTS,
        },
        ({ index }) => {
          calls.push(index);
        },
      ),
    ).rejects.toThrow(/model-key release denied/);
    expect(calls).toEqual([]);
  });
});
