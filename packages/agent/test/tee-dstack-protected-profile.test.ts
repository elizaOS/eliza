/**
 * Positive protected-profile path without hardware. The profile is captured
 * from this process's environment pointing at a fake dstack guest agent and a
 * SHA-256-pinned stub verifier; ensureProtectedProfileAdmission then admits,
 * and the sealed state volume and TDX CPU confidential weights unseal through
 * the dstack guest `GetKey` client after this CVM appraises its own evidence.
 * Unpinned clients, a foreign KMS root, debug evidence and GPU topologies
 * without GPU attestation stay refused.
 */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  assertProtectedKeyReleaseClient,
  ensureProtectedProfileAdmission,
  isProtectedProfileSelected,
  protectedTeeEnvironment,
} from "../src/security/protected-profile.ts";
import { sealModelWeightsShards } from "../src/services/tee-confidential-inference.ts";
import { DstackGuestKeyReleaseClient } from "../src/services/tee-dstack-key-release.ts";
import { mergeDstackCpuProductionProfile } from "../src/services/tee-dstack-production-profile.ts";
import { resolveDstackEvidenceConfiguration } from "../src/services/tee-dstack-release.ts";
import { resolveTeeEvidenceProvider } from "../src/services/tee-evidence-provider.ts";
import type { TeeReportDataBoundEvidenceProvider } from "../src/services/tee-key-release.ts";
import { prepareConfidentialModelWeights } from "../src/services/tee-model-key-boot.ts";
import {
  openSealedVolumeMetadata,
  sealVolumeMetadata,
  unsealStateVolumeKey,
} from "../src/services/tee-sealed-volume.ts";
import {
  type DstackHarness,
  startDstackHarness,
} from "./support/dstack-tdx-harness.ts";

let harness: DstackHarness;
beforeAll(async () => {
  harness = await startDstackHarness();
  // Captured once at first use; nothing in this process has read it yet.
  Object.assign(process.env, await harness.environment(), {
    ELIZA_PROTECTED_PROFILE: "dstack-cpu",
  });
});
afterAll(async () => {
  await harness?.close();
});

function dstackClient(overrides: { kmsRootPublicKey?: string } = {}) {
  const env = protectedTeeEnvironment();
  const config = resolveDstackEvidenceConfiguration(env);
  const provider = resolveTeeEvidenceProvider({
    env,
  }) as TeeReportDataBoundEvidenceProvider;
  return new DstackGuestKeyReleaseClient({
    evidenceProvider: provider,
    socketPath: config.socketPath,
    appId: config.appId,
    kmsRootPublicKey:
      overrides.kmsRootPublicKey ?? String(config.kmsRootPublicKey),
  });
}

function productionPolicy() {
  return mergeDstackCpuProductionProfile(undefined, protectedTeeEnvironment());
}

it("admits the protected profile against pinned dstack evidence", async () => {
  expect(isProtectedProfileSelected()).toBe(true);
  await expect(ensureProtectedProfileAdmission()).resolves.toBeUndefined();
}, 60_000);

it("unseals the state volume through dstack GetKey with dstack TDX measurements", async () => {
  const policy = productionPolicy();
  expect(policy.requiredMeasurements).toMatchObject({
    app: expect.any(String),
    compose: expect.any(String),
    os: expect.any(String),
  });
  const first = await unsealStateVolumeKey({
    keyReleaseClient: dstackClient(),
    policy,
  });
  expect(first.keyMaterialHex).toMatch(/^[0-9a-f]{64}$/);
  expect(first.decision.evidence?.provider).toBe("dstack");
  const sealed = sealVolumeMetadata({
    metadata: Buffer.from("luks-passphrase"),
    keyMaterialHex: first.keyMaterialHex,
  });
  // The dstack KDF is deterministic for this app: a later boot recovers it.
  const second = await unsealStateVolumeKey({
    keyReleaseClient: dstackClient(),
    policy,
  });
  expect(
    openSealedVolumeMetadata(sealed, second.keyMaterialHex).toString(),
  ).toBe("luks-passphrase");
  // A different context derives an unrelated key.
  const other = await unsealStateVolumeKey({
    keyReleaseClient: dstackClient(),
    policy,
    context: "another-user",
  });
  expect(other.keyMaterialHex).not.toBe(first.keyMaterialHex);
}, 60_000);

it("unseals confidential weights on the TDX CPU topology without GPU/NPU claims", async () => {
  const policy = productionPolicy();
  const client = dstackClient();
  const key = Buffer.from(
    (await client.releaseKey({ keyId: "model-key", policy })).keyMaterialHex,
    "hex",
  );
  const weights = randomBytes(4096);
  const [shard] = sealModelWeightsShards({
    weights,
    key,
    shardSizeBytes: weights.length,
  }).shards;
  if (!shard) throw new Error("expected one shard");
  const sealedWeights = {
    algorithm: "aes-256-gcm" as const,
    ivBase64: shard.ivBase64,
    authTagBase64: shard.authTagBase64,
    ciphertextBase64: shard.ciphertextBase64,
    weightsSha256: createHash("sha256").update(weights).digest("hex"),
  };
  const env = { ELIZA_CONFIDENTIAL_WEIGHTS: "1" };
  const unsealed = await prepareConfidentialModelWeights({
    keyReleaseClient: client,
    policy,
    sealedWeights,
    requiredMeasurements: ["app", "compose", "os"],
    topology: "tdx-cpu",
    env,
  });
  expect(unsealed?.weights.equals(weights)).toBe(true);
  // GPU topologies still require a GPU attestation claim dstack CPU evidence lacks.
  await expect(
    prepareConfidentialModelWeights({
      keyReleaseClient: client,
      policy,
      sealedWeights,
      requiredMeasurements: [],
      topology: "cloud",
      env,
    }),
  ).rejects.toThrow(/gpuProtected/);
  // tdx-cpu refuses a policy that does not pin the dstack TDX identity.
  await expect(
    prepareConfidentialModelWeights({
      keyReleaseClient: client,
      policy: { ...policy, allowedProviders: undefined },
      sealedWeights,
      requiredMeasurements: [],
      topology: "tdx-cpu",
      env,
    }),
  ).rejects.toThrow(/admitting only dstack TDX evidence/);
}, 60_000);

it("refuses unpinned KMS roots, foreign KMS chains and debug evidence", async () => {
  const policy = productionPolicy();
  expect(() =>
    assertProtectedKeyReleaseClient(
      dstackClient({ kmsRootPublicKey: `02${"11".repeat(32)}` }),
      "state-volume",
    ),
  ).toThrow(
    expect.objectContaining({ code: "PROTECTED_PROFILE_KEY_RELEASE_REJECTED" }),
  );
  class Overriding extends DstackGuestKeyReleaseClient {}
  const config = resolveDstackEvidenceConfiguration(protectedTeeEnvironment());
  const subclass = new Overriding({
    evidenceProvider: resolveTeeEvidenceProvider({
      env: protectedTeeEnvironment(),
    }) as TeeReportDataBoundEvidenceProvider,
    socketPath: config.socketPath,
    appId: config.appId,
    kmsRootPublicKey: String(config.kmsRootPublicKey),
  });
  await expect(
    unsealStateVolumeKey({ keyReleaseClient: subclass, policy }),
  ).rejects.toMatchObject({ code: "PROTECTED_PROFILE_KEY_RELEASE_REJECTED" });

  try {
    harness.guest.mode.foreignKms = true;
    await expect(
      unsealStateVolumeKey({ keyReleaseClient: dstackClient(), policy }),
    ).rejects.toMatchObject({ code: "TEE_DSTACK_KEY_RELEASE_REJECTED" });
    harness.guest.mode.foreignKms = false;
    harness.guest.mode.debug = true;
    const before = harness.guest.requests.filter(
      (path) => path === "/v1/GetKey",
    ).length;
    await expect(
      unsealStateVolumeKey({ keyReleaseClient: dstackClient(), policy }),
    ).rejects.toThrow(/Dstack evidence collection\/appraisal failed/);
    // No key was requested once our own evidence failed appraisal.
    expect(
      harness.guest.requests.filter((path) => path === "/v1/GetKey").length,
    ).toBe(before);
  } finally {
    harness.guest.mode.foreignKms = false;
    harness.guest.mode.debug = false;
  }
}, 60_000);
