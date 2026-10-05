/**
 * dstack TDX + NVIDIA confidential GPU admission end to end without hardware.
 * The real dstack provider collects a TDX attestation from a fake guest agent,
 * appraises it with a pinned stub verifier, then attests the GPU through a
 * SHA-256-pinned `nvattest`-compatible collector and a local NRAS emulator
 * (HTTPS, x5c-anchored JWKS, ES384 EAT bundles) with the same request nonce.
 * Verified GPU claims satisfy the GPU weights topology; GPU claims supplied by
 * any other input are ignored; every GPU failure rejects the whole evidence.
 */
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConfidentialLocalAdmission } from "../src/security/confidential-local-admission.ts";
import {
  sealModelWeightsShards,
  unsealModelWeights,
} from "../src/services/tee-confidential-inference.ts";
import { createDstackEvidenceProvider } from "../src/services/tee-dstack-evidence.ts";
import { DstackGuestKeyReleaseClient } from "../src/services/tee-dstack-key-release.ts";
import { mergeDstackCpuProductionProfile } from "../src/services/tee-dstack-production-profile.ts";
import { resolveDstackEvidenceConfiguration } from "../src/services/tee-dstack-release.ts";
import { nvidiaGpuFirmwareDigest } from "../src/services/tee-gpu-nvidia.ts";
import { evaluateTeeEvidencePolicy } from "../src/services/tee-policy.ts";
import {
  DSTACK_TDX_CLOUD_CLAIMS,
  mergeTeeProductionProfile,
} from "../src/services/tee-production-profile.ts";
import {
  causeChain,
  type DstackHarness,
  startDstackHarness,
} from "./support/dstack-tdx-harness.ts";
import {
  GPU_FIRMWARE,
  type NrasEmulator,
  startNrasEmulator,
  writePinnedCollector,
} from "./support/nras-emulator.ts";

let harness: DstackHarness;
let nras: NrasEmulator;
let collector: { path: string; sha256: string };
const expectedFirmware = () =>
  nvidiaGpuFirmwareDigest([
    {
      hwModel: GPU_FIRMWARE.hwModel,
      driverVersion: GPU_FIRMWARE.driver,
      vbiosVersion: GPU_FIRMWARE.vbios,
    },
  ]);

beforeAll(async () => {
  harness = await startDstackHarness();
  nras = await startNrasEmulator(harness.directory);
  collector = await writePinnedCollector(harness.directory, "nvattest");
}, 60_000);
afterAll(async () => {
  await nras?.close();
  await harness?.close();
});

function gpuConfig(overrides: Record<string, unknown> = {}) {
  return {
    collector,
    nrasUrl: `${nras.origin}/v4/attest/gpu`,
    jwks: {
      source: "fetched",
      url: `${nras.origin}/.well-known/jwks.json`,
      x5cTrustAnchorSha256: [nras.anchorSha256],
    },
    trustedCaPem: nras.caPem,
    timeoutMs: 20_000,
    policy: {
      allowedArchitectures: ["HOPPER"],
      allowedDriverVersions: [GPU_FIRMWARE.driver],
      allowedVbiosVersions: [GPU_FIRMWARE.vbios],
      allowedHwModels: [GPU_FIRMWARE.hwModel],
      expectedGpuCount: 1,
    },
    ...overrides,
  };
}

function reset(): void {
  for (const key of Object.keys(harness.guest.mode))
    delete harness.guest.mode[key as keyof typeof harness.guest.mode];
  for (const key of Object.keys(nras.behaviour))
    delete nras.behaviour[key as keyof typeof nras.behaviour];
}

async function appraise(env: Record<string, string>) {
  const admitted = await createConfidentialLocalAdmission(env).then(
    () => true,
    () => false,
  );
  try {
    const provider = createDstackEvidenceProvider(
      resolveDstackEvidenceConfiguration(env),
    );
    return { admitted, evidence: await provider.collectEvidence() };
  } catch (error) {
    return { admitted, failure: causeChain(error) };
  }
}

describe("dstack TDX + NVIDIA GPU evidence", () => {
  it("admits a GPU policy with verified gpuProtected/gpuFirmware bound to the TDX nonce", async () => {
    reset();
    const env = await harness.environment({ gpu: gpuConfig() });
    const policy = mergeDstackCpuProductionProfile(undefined, env);
    expect(policy.requiredClaims?.gpuProtected).toBe(true);
    expect(policy.requiredMeasurements?.gpuFirmware).toBe(expectedFirmware());
    const { admitted, evidence } = await appraise(env);
    expect(admitted).toBe(true);
    expect(evidence).toMatchObject({
      kind: "tdx",
      provider: "dstack",
      claims: { debugDisabled: true, gpuProtected: true },
      measurements: { gpuFirmware: expectedFirmware() },
    });

    // The GPU is attested with the same nonce whose hash is in report_data.
    const provider = createDstackEvidenceProvider(
      resolveDstackEvidenceConfiguration(env),
    );
    const nonce = randomBytes(32).toString("hex");
    const reportDataHex = createHash("sha256")
      .update(Buffer.from(nonce, "hex"))
      .digest("hex");
    const bound = await provider.collectEvidenceWithReportData({
      nonce,
      reportDataHex,
    });
    expect(bound.reportData).toBe(reportDataHex);
    expect(nras.requests.at(-1)?.nonce).toBe(nonce);
    expect(evaluateTeeEvidencePolicy(bound, policy).trusted).toBe(true);

    // The same claims from any other input document are not honoured.
    for (const forged of [JSON.parse(JSON.stringify(bound)), { ...bound }]) {
      expect(evaluateTeeEvidencePolicy(forged, policy)).toMatchObject({
        trusted: false,
        reason: "measurement-mismatch",
      });
    }
    const withoutFirmwarePin = {
      ...policy,
      requiredMeasurements: { app: String(policy.requiredMeasurements?.app) },
    };
    expect(
      evaluateTeeEvidencePolicy({ ...bound }, withoutFirmwarePin),
    ).toMatchObject({ trusted: false, reason: "claim-mismatch" });
  }, 60_000);

  it("unseals weights on the GPU (cloud) topology from real verified evidence", async () => {
    reset();
    const env = await harness.environment({ gpu: gpuConfig() });
    const config = resolveDstackEvidenceConfiguration(env);
    const policy = mergeDstackCpuProductionProfile(undefined, env);
    const client = new DstackGuestKeyReleaseClient({
      evidenceProvider: createDstackEvidenceProvider(config),
      socketPath: config.socketPath,
      appId: config.appId,
      kmsRootPublicKey: String(config.kmsRootPublicKey),
    });
    const release = await client.releaseKey({ keyId: "model-key", policy });
    expect(release.decision.evidence?.claims?.gpuProtected).toBe(true);
    const weights = randomBytes(2048);
    const [shard] = sealModelWeightsShards({
      weights,
      key: Buffer.from(release.keyMaterialHex, "hex"),
      shardSizeBytes: weights.length,
    }).shards;
    if (!shard) throw new Error("expected one shard");
    const unsealed = await unsealModelWeights({
      keyReleaseClient: client,
      policy,
      sealedWeights: {
        algorithm: "aes-256-gcm",
        ivBase64: shard.ivBase64,
        authTagBase64: shard.authTagBase64,
        ciphertextBase64: shard.ciphertextBase64,
        weightsSha256: createHash("sha256").update(weights).digest("hex"),
      },
      requiredMeasurements: ["app", "compose", "os", "gpuFirmware"],
      topology: "cloud",
    });
    expect(unsealed.weights.equals(weights)).toBe(true);
  }, 60_000);

  it("attests the GPU only after the TDX quote passed", async () => {
    reset();
    harness.guest.mode.debug = true;
    const before = nras.requests.length;
    const { admitted, failure } = await appraise(
      await harness.environment({ gpu: gpuConfig() }),
    );
    expect(admitted).toBe(false);
    expect(failure).toMatch(/debuggable trust domain/);
    expect(nras.requests.length).toBe(before);
    reset();
  }, 60_000);

  const failures: Array<{
    name: string;
    setup: () => Promise<Record<string, unknown>>;
    nras?: NrasEmulator["behaviour"];
    cause: RegExp;
  }> = [
    {
      name: "NRAS token nonce not bound to the TDX request nonce",
      setup: async () => gpuConfig(),
      nras: { foreignNonce: randomBytes(32).toString("hex") },
      cause: /eat_nonce does not match the challenge/,
    },
    {
      name: "collector evidence bound to another nonce",
      setup: async () => ({
        ...gpuConfig(),
        collector: await writePinnedCollector(
          harness.directory,
          "nvattest-stale",
          randomBytes(32).toString("hex"),
        ),
      }),
      cause: /bound to another nonce/,
    },
    {
      name: "NRAS appraisal rejects the GPU",
      setup: async () => gpuConfig(),
      nras: { overallResultFalse: true },
      cause: /overall attestation result is not true/,
    },
    {
      name: "NRAS refuses the request",
      setup: async () => gpuConfig(),
      nras: { httpStatus: 403 },
      cause: /HTTP 403/,
    },
    {
      name: "GPU firmware outside the pinned policy",
      setup: async () =>
        gpuConfig({
          policy: { allowedDriverVersions: ["999.99"], expectedGpuCount: 1 },
        }),
      cause: /not in the pinned policy/,
    },
    {
      name: "gpu configured but the collector binary is missing",
      setup: async () =>
        gpuConfig({
          collector: {
            path: path.join(harness.directory, "missing-nvattest"),
            sha256: collector.sha256,
          },
        }),
      cause: /ENOENT|missing-nvattest/,
    },
    {
      name: "gpu configured but no collector declared",
      setup: async () => {
        const { collector: _omit, ...rest } = gpuConfig();
        return rest;
      },
      cause: /collector/,
    },
  ];

  it.each(failures)(
    "rejects the whole evidence: $name",
    async (scenario) => {
      reset();
      Object.assign(nras.behaviour, scenario.nras ?? {});
      const { admitted, evidence, failure } = await appraise(
        await harness.environment({ gpu: await scenario.setup() }),
      );
      expect(admitted).toBe(false);
      expect(evidence).toBeUndefined();
      expect(failure).toMatch(scenario.cause);
      reset();
    },
    60_000,
  );
});

describe("dstack TDX + NVIDIA cloud-inference production profile", () => {
  async function cloudPolicy(env: Record<string, string>) {
    return mergeDstackCpuProductionProfile(undefined, env);
  }

  it("requires exactly the established claims and admits real-shaped evidence", async () => {
    reset();
    const env = await harness.environment({ gpu: gpuConfig() });
    const policy = await cloudPolicy(env);
    expect(policy.requiredClaims).toEqual(DSTACK_TDX_CLOUD_CLAIMS);
    expect(policy.requiredClaims).not.toHaveProperty("secureBoot");
    expect(policy.requiredClaims).not.toHaveProperty("ioProtected");
    expect(policy.requiredMeasurements?.os).toMatch(/^[0-9a-f]{64}$/);
    const { admitted, evidence } = await appraise(env);
    expect(admitted).toBe(true);
    expect(evidence?.claims).toEqual({
      debugDisabled: true,
      memoryEncrypted: true,
      productionLifecycle: true,
      gpuProtected: true,
    });
    expect(evaluateTeeEvidencePolicy(evidence, policy).trusted).toBe(true);
  }, 60_000);

  it("keeps the generic cloud floor unsatisfiable: secureBoot and ioProtected are never invented", async () => {
    reset();
    const env = await harness.environment({ gpu: gpuConfig() });
    const { evidence } = await appraise(env);
    const generic = mergeTeeProductionProfile(await cloudPolicy(env), {
      inference: "cloud",
    });
    expect(evaluateTeeEvidencePolicy(evidence, generic)).toMatchObject({
      trusted: false,
      reason: "claim-mismatch",
    });
    expect(() =>
      mergeTeeProductionProfile(
        { requiredMeasurements: { app: "a".repeat(40) } },
        { inference: "cloud", platform: "dstack-tdx" },
      ),
    ).toThrow(/pinned `os`/);
  }, 60_000);

  it("fails productionLifecycle when the verifier cannot say the OS image is production", async () => {
    reset();
    const env = await harness.environment({
      gpu: gpuConfig(),
      verifier: { details: { os_image_is_dev: null } },
    });
    const { admitted, evidence } = await appraise(env);
    expect(admitted).toBe(false);
    expect(evidence?.claims).not.toHaveProperty("productionLifecycle");
    expect(
      evaluateTeeEvidencePolicy(evidence, await cloudPolicy(env)),
    ).toMatchObject({
      trusted: false,
      reason: "claim-mismatch",
      detail: expect.stringContaining("productionLifecycle"),
    });
  }, 60_000);

  it("fails gpuProtected for CPU-only evidence", async () => {
    reset();
    const gpuEnv = await harness.environment({ gpu: gpuConfig() });
    const { evidence } = await appraise(await harness.environment());
    expect(evidence?.claims).not.toHaveProperty("gpuProtected");
    const withoutFirmware = await cloudPolicy(gpuEnv);
    delete withoutFirmware.requiredMeasurements?.gpuFirmware;
    expect(evaluateTeeEvidencePolicy(evidence, withoutFirmware)).toMatchObject({
      trusted: false,
      reason: "claim-mismatch",
      detail: expect.stringContaining("gpuProtected"),
    });
  }, 60_000);

  const sources: Array<{
    claim: string;
    name: string;
    env?: Parameters<DstackHarness["environment"]>[0];
    mode?: Partial<typeof harness.guest.mode>;
    nras?: NrasEmulator["behaviour"];
    cause: RegExp;
  }> = [
    {
      claim: "memoryEncrypted",
      name: "TDX quote not verified (untrusted attestation key)",
      mode: { untrustedAttestationKey: true },
      cause: /Pinned verifier rejected the attestation/,
    },
    {
      claim: "productionLifecycle",
      name: "TD debug bit set",
      mode: { debug: true },
      cause: /debuggable trust domain/,
    },
    {
      claim: "productionLifecycle",
      name: "TCB OutOfDate",
      env: { verifier: { details: { tcb_status: "OutOfDate" } } },
      cause: /production appraisal policy/,
    },
    {
      claim: "productionLifecycle",
      name: "development OS image",
      env: { verifier: { details: { os_image_is_dev: true } } },
      cause: /production appraisal policy/,
    },
    {
      claim: "productionLifecycle",
      name: "open advisories",
      env: { verifier: { details: { advisory_ids: ["INTEL-SA-01234"] } } },
      cause: /advisory_ids/,
    },
    {
      claim: "os (measured boot)",
      name: "OS image hash differs from the pinned image",
      env: {
        verifier: { appInfoOverrides: { os_image_hash: "0".repeat(64) } },
      },
      cause: /deployment identity does not match/,
    },
    {
      claim: "gpuProtected",
      name: "NRAS appraisal fails",
      nras: { overallResultFalse: true },
      cause: /overall attestation result is not true/,
    },
  ];

  it.each(sources)(
    "$claim fails when its source fails: $name",
    async (scenario) => {
      reset();
      Object.assign(harness.guest.mode, scenario.mode ?? {});
      Object.assign(nras.behaviour, scenario.nras ?? {});
      const { admitted, failure } = await appraise(
        await harness.environment({ ...scenario.env, gpu: gpuConfig() }),
      );
      expect(admitted).toBe(false);
      expect(failure).toMatch(scenario.cause);
      reset();
    },
    60_000,
  );
});
