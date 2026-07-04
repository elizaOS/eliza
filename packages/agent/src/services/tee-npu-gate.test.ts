/**
 * Pins the fail-closed NPU/GPU private-inference gate at the model-weights
 * unseal seam: local topology requires `npuProtected` plus a non-empty
 * `npuFirmware` digest, cloud topology requires the GPU equivalents.
 * Deterministic and hardware-free — a fixture key-release client with locally
 * sealed weights drives `assertNpuPrivateInferenceAllowed` and the unseal path.
 */
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertNpuPrivateInferenceAllowed,
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

/**
 * Phase C item C2 (plan §2.4): private (on-device) inference / model-key unseal
 * must NOT proceed unless the policy gates `npuProtected === true` AND a
 * non-empty `npuFirmware` golden digest (local topology), or the GPU
 * equivalent (cloud topology). These tests pin that fail-closed binding at the
 * unseal seam, independent of any production-profile default.
 */

const PLAINTEXT_WEIGHTS = Buffer.from("eliza-1 npu-gate fixture", "utf8");
const WEIGHTS_SHA256 = createHash("sha256")
  .update(PLAINTEXT_WEIGHTS)
  .digest("hex");

const REQUIRED_MEASUREMENTS = [
  "agent",
  "policy",
  "container",
  "os",
  "modelWeights",
] as const;

/** A policy that gates everything the unseal path needs EXCEPT the NPU/GPU
 * lane; tests add the lane fields to make it valid. */
function baseLocalPolicy(): TeeEvidencePolicy {
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

function cloudPolicy(): TeeEvidencePolicy {
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
      gpuFirmware: "sha256:gpufw",
      modelWeights: `sha256:${WEIGHTS_SHA256}`,
    },
    requiredClaims: { debugDisabled: true, gpuProtected: true },
  };
}

function localEvidence() {
  return {
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
      npuProtected: true,
    },
  };
}

function cloudEvidence() {
  return {
    kind: "tdx",
    provider: "dstack",
    hardwareVendor: "intel",
    securityVersion: 7,
    measurements: {
      agent: "sha256:agent",
      policy: "sha256:policy",
      container: "sha256:container",
      os: "sha256:os",
      gpuFirmware: "sha256:gpufw",
      modelWeights: `sha256:${WEIGHTS_SHA256}`,
    },
    freshness: {
      nonce: "n1",
      timestamp: "2026-05-20T12:00:00.000Z",
      verifier: "intel-pcs",
    },
    claims: {
      debugDisabled: true,
      gpuProtected: true,
    },
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

describe("assertNpuPrivateInferenceAllowed", () => {
  it("allows when local policy gates npuProtected + npuFirmware", () => {
    expect(() =>
      assertNpuPrivateInferenceAllowed(baseLocalPolicy()),
    ).not.toThrow();
    expect(() =>
      assertNpuPrivateInferenceAllowed(baseLocalPolicy(), "local"),
    ).not.toThrow();
  });

  it("rejects when npuProtected claim is not gated", () => {
    const p = baseLocalPolicy();
    delete p.requiredClaims?.npuProtected;
    expect(() => assertNpuPrivateInferenceAllowed(p)).toThrow(
      /claim "npuProtected" === true/,
    );
  });

  it("rejects when npuProtected is gated to false", () => {
    const p = baseLocalPolicy();
    p.requiredClaims = { ...p.requiredClaims, npuProtected: false };
    expect(() => assertNpuPrivateInferenceAllowed(p)).toThrow(
      /claim "npuProtected" === true/,
    );
  });

  it("rejects when npuFirmware measurement is absent", () => {
    const p = baseLocalPolicy();
    delete p.requiredMeasurements?.npuFirmware;
    expect(() => assertNpuPrivateInferenceAllowed(p)).toThrow(
      /non-empty "npuFirmware" measurement/,
    );
  });

  it("rejects when npuFirmware measurement is an empty digest", () => {
    const p = baseLocalPolicy();
    if (p.requiredMeasurements) p.requiredMeasurements.npuFirmware = "   ";
    expect(() => assertNpuPrivateInferenceAllowed(p)).toThrow(
      /non-empty "npuFirmware" measurement/,
    );
  });

  it("cloud topology requires gpuProtected + gpuFirmware instead", () => {
    expect(() =>
      assertNpuPrivateInferenceAllowed(cloudPolicy(), "cloud"),
    ).not.toThrow();

    const noGpuClaim = cloudPolicy();
    delete noGpuClaim.requiredClaims?.gpuProtected;
    expect(() => assertNpuPrivateInferenceAllowed(noGpuClaim, "cloud")).toThrow(
      /claim "gpuProtected" === true/,
    );

    const noGpuFw = cloudPolicy();
    delete noGpuFw.requiredMeasurements?.gpuFirmware;
    expect(() => assertNpuPrivateInferenceAllowed(noGpuFw, "cloud")).toThrow(
      /non-empty "gpuFirmware" measurement/,
    );
  });

  it("a local-only policy is rejected for the cloud topology (npu gates are not gpu gates)", () => {
    expect(() =>
      assertNpuPrivateInferenceAllowed(baseLocalPolicy(), "cloud"),
    ).toThrow(/claim "gpuProtected" === true/);
  });
});

describe("unsealModelWeights NPU private-inference gate (C2)", () => {
  it("rejects local unseal when npuProtected is not gated", async () => {
    const key = randomBytes(32);
    const sealed = sealWith(key);
    const p = baseLocalPolicy();
    delete p.requiredClaims?.npuProtected;
    await expect(
      unsealModelWeights({
        keyReleaseClient: fixtureKeyReleaseClient(key, localEvidence()),
        policy: p,
        sealedWeights: sealed,
        requiredMeasurements: REQUIRED_MEASUREMENTS,
      }),
    ).rejects.toThrow(/claim "npuProtected" === true/);
  });

  it("rejects local unseal when npuFirmware digest is absent", async () => {
    const key = randomBytes(32);
    const sealed = sealWith(key);
    const p = baseLocalPolicy();
    delete p.requiredMeasurements?.npuFirmware;
    await expect(
      unsealModelWeights({
        keyReleaseClient: fixtureKeyReleaseClient(key, localEvidence()),
        policy: p,
        sealedWeights: sealed,
        requiredMeasurements: REQUIRED_MEASUREMENTS,
      }),
    ).rejects.toThrow(/non-empty "npuFirmware" measurement/);
  });

  it("allows local unseal when both npuProtected and npuFirmware are gated", async () => {
    const key = randomBytes(32);
    const sealed = sealWith(key);
    const result = await unsealModelWeights({
      keyReleaseClient: fixtureKeyReleaseClient(key, localEvidence()),
      policy: baseLocalPolicy(),
      sealedWeights: sealed,
      requiredMeasurements: REQUIRED_MEASUREMENTS,
      context: "eliza-1",
    });
    expect(result.weights.equals(PLAINTEXT_WEIGHTS)).toBe(true);
    expect(result.decision.trusted).toBe(true);
  });

  it("cloud topology unseal requires gpuProtected + gpuFirmware", async () => {
    const key = randomBytes(32);
    const sealed = sealWith(key);
    // A local policy is insufficient for cloud topology.
    await expect(
      unsealModelWeights({
        keyReleaseClient: fixtureKeyReleaseClient(key, cloudEvidence()),
        policy: baseLocalPolicy(),
        sealedWeights: sealed,
        requiredMeasurements: REQUIRED_MEASUREMENTS,
        topology: "cloud",
      }),
    ).rejects.toThrow(/claim "gpuProtected" === true/);

    // A proper cloud policy + evidence succeeds.
    const result = await unsealModelWeights({
      keyReleaseClient: fixtureKeyReleaseClient(key, cloudEvidence()),
      policy: cloudPolicy(),
      sealedWeights: sealed,
      requiredMeasurements: REQUIRED_MEASUREMENTS,
      topology: "cloud",
    });
    expect(result.weights.equals(PLAINTEXT_WEIGHTS)).toBe(true);
    expect(result.decision.trusted).toBe(true);
  });
});

describe("unsealModelWeightsStreaming NPU private-inference gate (C2)", () => {
  it("rejects streaming unseal (no shard handed) when npuFirmware is absent", async () => {
    const key = randomBytes(32);
    const manifest = sealModelWeightsShards({
      weights: PLAINTEXT_WEIGHTS,
      key,
      shardSizeBytes: 8,
    });
    const p = baseLocalPolicy();
    delete p.requiredMeasurements?.npuFirmware;
    const calls: number[] = [];
    await expect(
      unsealModelWeightsStreaming(
        {
          keyReleaseClient: fixtureKeyReleaseClient(key, localEvidence()),
          policy: p,
          sealedWeights: manifest,
          requiredMeasurements: REQUIRED_MEASUREMENTS,
        },
        ({ index }) => {
          calls.push(index);
        },
      ),
    ).rejects.toThrow(/non-empty "npuFirmware" measurement/);
    expect(calls).toEqual([]);
  });

  it("allows streaming unseal when npuProtected + npuFirmware are gated", async () => {
    const key = randomBytes(32);
    const manifest = sealModelWeightsShards({
      weights: PLAINTEXT_WEIGHTS,
      key,
      shardSizeBytes: 8,
    });
    const chunks: Buffer[] = [];
    const result = await unsealModelWeightsStreaming(
      {
        keyReleaseClient: fixtureKeyReleaseClient(key, localEvidence()),
        policy: baseLocalPolicy(),
        sealedWeights: manifest,
        requiredMeasurements: REQUIRED_MEASUREMENTS,
      },
      ({ bytes }) => {
        chunks.push(Buffer.from(bytes));
      },
    );
    expect(Buffer.concat(chunks).equals(PLAINTEXT_WEIGHTS)).toBe(true);
    expect(result.decision.trusted).toBe(true);
  });
});
