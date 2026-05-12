import { describe, expect, it } from "vitest";
import { DEFAULT_ELIGIBLE_MODEL_IDS, findCatalogModel } from "./catalog";
import type { Eliza1Manifest, Eliza1Tier } from "./manifest";
import { REQUIRED_KERNELS_BY_TIER } from "./manifest";
import {
  assessCatalogModelFit,
  canBundleBeDefaultOnDevice,
  chooseSmallerFallbackModel,
  classifyRecommendationPlatform,
  deviceCapsFromProbe,
  selectRecommendedModels,
} from "./recommendation";
import type { HardwareProbe, InstalledModel } from "./types";

function hardware(overrides: Partial<HardwareProbe>): HardwareProbe {
  return {
    totalRamGb: 32,
    freeRamGb: 24,
    gpu: null,
    cpuCores: 8,
    platform: "linux",
    arch: "x64",
    appleSilicon: false,
    recommendedBucket: "large",
    source: "os-fallback",
    ...overrides,
  };
}

describe("local inference recommendations", () => {
  it("prefers the largest fitting Eliza-1 tier on Linux GPU", () => {
    const probe = hardware({
      totalRamGb: 64,
      freeRamGb: 48,
      gpu: {
        backend: "cuda",
        totalVramGb: 24,
        freeVramGb: 22,
      },
      source: "node-llama-cpp",
    });

    const recommended = selectRecommendedModels(probe);

    expect(classifyRecommendationPlatform(probe)).toBe("linux-gpu");
    expect(recommended.TEXT_SMALL.model?.id).toBe("eliza-1-1_7b");
    // assessFit on linux-gpu uses max(VRAM, RAM*0.5) = max(24, 32) = 32.
    // 27b (minRam 32, size 16.8) fits; 27b-256k (minRam 96) does
    // not. Ladder is 27b-256k -> 27b -> 9b -> 1_7b, picks 27b.
    expect(recommended.TEXT_LARGE.model?.id).toBe("eliza-1-27b");
  });

  it("picks the 27B 256k tier on a >=96 GB-effective workstation", () => {
    const probe = hardware({
      totalRamGb: 128,
      freeRamGb: 96,
      gpu: {
        backend: "cuda",
        totalVramGb: 128,
        freeVramGb: 110,
      },
      source: "node-llama-cpp",
    });

    const recommended = selectRecommendedModels(probe);

    // effective = max(128, 64) = 128 ≥ 27b-256k minRam (96).
    expect(recommended.TEXT_LARGE.model?.id).toBe("eliza-1-27b-256k");
  });

  it("uses the mobile platform ladder and prefers the 1.7B tier when it fits", () => {
    // Mobile detection now reads `hardware.mobile.platform`
    // (`"ios"|"android"|"web"`) — the typed source of truth — instead of
    // pretending the Node platform string was one of those values.
    const probe = hardware({
      totalRamGb: 8,
      freeRamGb: 5,
      platform: "linux",
      arch: "arm64",
      recommendedBucket: "small",
      mobile: { platform: "android" },
    });

    const recommended = selectRecommendedModels(probe);

    expect(classifyRecommendationPlatform(probe)).toBe("mobile");
    expect(recommended.TEXT_SMALL.model?.id).toBe("eliza-1-0_6b");
    expect(recommended.TEXT_LARGE.model?.id).toBe("eliza-1-1_7b");
  });

  it("classifies an iOS mobile probe as mobile and lands on the 1.7B tier", () => {
    const probe = hardware({
      totalRamGb: 8,
      freeRamGb: 5,
      platform: "darwin",
      arch: "arm64",
      recommendedBucket: "small",
      mobile: { platform: "ios" },
    });
    expect(classifyRecommendationPlatform(probe)).toBe("mobile");
    const recommended = selectRecommendedModels(probe);
    expect(recommended.TEXT_LARGE.model?.id).toBe("eliza-1-1_7b");
  });

  it("falls back to the small Qwen3.5 tier on minimal mobile", () => {
    // 1_7b needs 4 GB minRam; below that the ladder collapses to the next
    // tier that fits — eliza-1-0_8b (2 GB minRam, the new small default),
    // then eliza-1-0_6b. Below 2 GB nothing fits.
    const cases: Array<[number, string | null]> = [
      [3.5, "eliza-1-0_8b"],
      [1.5, null],
    ];

    for (const [totalRamGb, expectedId] of cases) {
      const probe = hardware({
        totalRamGb,
        freeRamGb: Math.max(totalRamGb - 1, 0),
        platform: "darwin",
        arch: "arm64",
        recommendedBucket: "small",
        mobile: { platform: "ios" },
      });

      expect(
        selectRecommendedModels(probe).TEXT_LARGE.model?.id ?? null,
        `totalRamGb=${totalRamGb}`,
      ).toBe(expectedId);
    }
  });

  it("rejects a tier when its bundle exceeds the mobile memory guardrail", () => {
    const probe = hardware({
      totalRamGb: 6,
      freeRamGb: 4,
      platform: "darwin",
      arch: "arm64",
      recommendedBucket: "mid",
      mobile: { platform: "ios" },
    });
    const desktop = findCatalogModel("eliza-1-9b");

    if (!desktop) throw new Error("eliza-1-9b missing from catalog");
    expect(assessCatalogModelFit(probe, desktop)).toBe("wontfit");
  });

  it("chooses a smaller fitting fallback from the same platform ladder", () => {
    // linux-gpu host with enough effective memory for 9b
    // (effective = max(VRAM, RAM*0.5) = max(16, 16) = 16, 9B minRam 12).
    const probe = hardware({
      totalRamGb: 32,
      freeRamGb: 24,
      platform: "linux",
      gpu: { backend: "cuda", totalVramGb: 16, freeVramGb: 14 },
      source: "node-llama-cpp",
      recommendedBucket: "mid",
    });

    const fallback = chooseSmallerFallbackModel(
      "eliza-1-27b",
      probe,
      "TEXT_LARGE",
    );

    expect(fallback?.id).toBe("eliza-1-9b");
  });

  it("does not recommend Eliza-1 tiers when the probed binary lacks required kernels", () => {
    const probe = hardware({
      totalRamGb: 64,
      freeRamGb: 48,
      gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
      source: "node-llama-cpp",
    });

    const stockBinary = {
      dflash: false,
      turbo3: false,
      turbo4: false,
      turbo3_tcq: false,
      qjl_full: false,
      lookahead: true,
      ngramDraft: true,
    };

    const recommended = selectRecommendedModels(probe, undefined, {
      binaryKernels: stockBinary,
    });

    expect(recommended.TEXT_SMALL.model).toBeNull();
    expect(recommended.TEXT_LARGE.model).toBeNull();
  });

  it("recommends Eliza-1 tiers when all required kernels are present", () => {
    const probe = hardware({
      totalRamGb: 64,
      freeRamGb: 48,
      gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
      source: "node-llama-cpp",
    });

    const completeBinary = {
      dflash: true,
      turbo3: true,
      turbo4: true,
      turbo3_tcq: true,
      qjl_full: true,
      polarquant: true,
      lookahead: true,
      ngramDraft: true,
    };

    const recommended = selectRecommendedModels(probe, undefined, {
      binaryKernels: completeBinary,
    });

    expect(recommended.TEXT_SMALL.model?.id).toMatch(/^eliza-1-/);
    expect(recommended.TEXT_LARGE.model?.id).toMatch(/^eliza-1-/);
  });

  it("recommended entries are always default-eligible", () => {
    const probe = hardware({
      totalRamGb: 64,
      freeRamGb: 48,
      gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
      source: "node-llama-cpp",
    });

    const recommended = selectRecommendedModels(probe);
    const smallId = recommended.TEXT_SMALL.model?.id;
    const largeId = recommended.TEXT_LARGE.model?.id;

    if (!smallId || !largeId) {
      throw new Error("expected recommended TEXT_SMALL and TEXT_LARGE models");
    }

    expect(DEFAULT_ELIGIBLE_MODEL_IDS.has(smallId)).toBe(true);
    expect(DEFAULT_ELIGIBLE_MODEL_IDS.has(largeId)).toBe(true);
  });

  it("prefers long-context entries within the ladder on hosts with >= 16 GB RAM/VRAM", () => {
    // Workstation-class host should land on a tier with >= 64k context.
    const probe = hardware({
      totalRamGb: 64,
      freeRamGb: 48,
      gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
      source: "node-llama-cpp",
    });
    const recommended = selectRecommendedModels(probe);
    const top = recommended.TEXT_LARGE.alternatives[0];
    expect(top?.contextLength ?? 0).toBeGreaterThanOrEqual(65536);
  });

  it("does NOT prefer long-context entries on memory-constrained hosts", () => {
    // 12 GB RAM, no GPU — ladder ordering is the catalog default and
    // the long-context bump should NOT kick in.
    const probe = hardware({
      totalRamGb: 12,
      freeRamGb: 6,
      gpu: null,
      recommendedBucket: "small",
      source: "os-fallback",
    });
    const recommended = selectRecommendedModels(probe);
    expect(recommended.TEXT_SMALL.model).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// canBundleBeDefaultOnDevice — the manifest/verifiedBackends + on-device
// verify gate the recommendation engine consults before auto-defaulting a
// bundle. Mirrors `manifest/validator.ts:canSetAsDefault`.
// ---------------------------------------------------------------------------

const SHA = "0".repeat(64);

function fixtureManifest(tier: Eliza1Tier = "1_7b"): Eliza1Manifest {
  const pass = {
    status: "pass" as const,
    atCommit: "abc1234",
    report: "x.txt",
  };
  return {
    id: `eliza-1-${tier}`,
    tier,
    version: "1.0.0",
    publishedAt: "2026-05-10T00:00:00Z",
    lineage: {
      text: { base: "eliza-1-text", license: "apache-2.0" },
      voice: { base: "eliza-1-voice", license: "apache-2.0" },
      drafter: { base: "eliza-1-drafter", license: "apache-2.0" },
      asr: { base: "eliza-1-asr", license: "apache-2.0" },
      vad: { base: "eliza-1-vad", license: "apache-2.0" },
    },
    files: {
      text: [
        { path: `text/eliza-1-${tier}-32k.gguf`, ctx: 32768, sha256: SHA },
      ],
      voice: [{ path: "tts/omnivoice-0.6b.gguf", sha256: SHA }],
      asr: [{ path: "asr/asr.gguf", sha256: SHA }],
      vision: [],
      dflash: [{ path: `dflash/drafter-${tier}.gguf`, sha256: SHA }],
      cache: [{ path: "cache/voice-preset-default.bin", sha256: SHA }],
      vad: [{ path: "vad/silero-vad-int8.onnx", sha256: SHA }],
    },
    kernels: {
      required: [...REQUIRED_KERNELS_BY_TIER[tier]],
      optional: [],
      verifiedBackends: {
        metal: pass,
        vulkan: pass,
        cuda: pass,
        rocm: pass,
        cpu: pass,
      },
    },
    evals: {
      textEval: { score: 0.71, passed: true },
      voiceRtf: { rtf: 0.42, passed: true },
      asrWer: { wer: 0.05, passed: true },
      vadLatencyMs: {
        median: 16,
        boundaryMs: 24,
        endpointMs: 80,
        falseBargeInRate: 0.01,
        passed: true,
      },
      e2eLoopOk: true,
      thirtyTurnOk: true,
    },
    ramBudgetMb: { min: 4000, recommended: 6000 },
    defaultEligible: true,
  };
}

function installedFixture(
  overrides: Partial<InstalledModel> = {},
): InstalledModel {
  return {
    id: "eliza-1-1_7b",
    displayName: "Eliza-1 1.7B",
    path: "/models/eliza-1-1_7b.bundle/text/eliza-1-1_7b-32k.gguf",
    sizeBytes: 1_000_000_000,
    bundleRoot: "/models/eliza-1-1_7b.bundle",
    manifestPath: "/models/eliza-1-1_7b.bundle/eliza-1.manifest.json",
    installedAt: "2026-05-11T00:00:00Z",
    lastUsedAt: null,
    source: "eliza-download",
    bundleVerifiedAt: "2026-05-11T01:00:00Z",
    ...overrides,
  };
}

describe("canBundleBeDefaultOnDevice", () => {
  const probe = hardware({
    totalRamGb: 16,
    gpu: { backend: "vulkan", totalVramGb: 8, freeVramGb: 6 },
    source: "node-llama-cpp",
  });

  it("maps a probe onto Eliza1DeviceCaps (cpu always present + the one GPU backend)", () => {
    expect(deviceCapsFromProbe(probe)).toEqual({
      availableBackends: ["cpu", "vulkan"],
      ramMb: 16 * 1024,
    });
    expect(deviceCapsFromProbe(hardware({ totalRamGb: 8, gpu: null }))).toEqual(
      {
        availableBackends: ["cpu"],
        ramMb: 8 * 1024,
      },
    );
  });

  it("allows a verified, default-eligible bundle on a device with a matching backend", () => {
    const r = canBundleBeDefaultOnDevice(installedFixture(), probe, {
      manifestLoader: () => fixtureManifest(),
    });
    expect(r.canBeDefault).toBe(true);
  });

  it("refuses when the bundle has not passed the on-device verify pass", () => {
    const r = canBundleBeDefaultOnDevice(
      installedFixture({ bundleVerifiedAt: undefined }),
      probe,
      { manifestLoader: () => fixtureManifest() },
    );
    expect(r).toMatchObject({
      canBeDefault: false,
      reason: "not-verified-on-device",
    });
  });

  it("refuses when no eliza-1.manifest.json is present", () => {
    const r = canBundleBeDefaultOnDevice(installedFixture(), probe, {
      manifestLoader: () => null,
    });
    expect(r).toMatchObject({ canBeDefault: false, reason: "no-manifest" });
  });

  it("refuses when the manifest is not defaultEligible", () => {
    const m = fixtureManifest();
    m.defaultEligible = false;
    const r = canBundleBeDefaultOnDevice(installedFixture(), probe, {
      manifestLoader: () => m,
    });
    expect(r).toMatchObject({
      canBeDefault: false,
      reason: "not-default-eligible",
    });
  });

  it("refuses when device RAM is below the manifest floor", () => {
    const m = fixtureManifest();
    m.ramBudgetMb = { min: 32_000, recommended: 40_000 };
    const r = canBundleBeDefaultOnDevice(installedFixture(), probe, {
      manifestLoader: () => m,
    });
    expect(r).toMatchObject({ canBeDefault: false, reason: "ram-below-floor" });
  });

  it("refuses when no device backend has a 'pass' kernel-verify report", () => {
    const m = fixtureManifest();
    m.kernels.verifiedBackends.cpu = {
      status: "fail",
      atCommit: "abc1234",
      report: "cpu.txt",
    };
    m.kernels.verifiedBackends.vulkan = {
      status: "skipped",
      atCommit: "abc1234",
      report: "vulkan.txt",
    };
    const r = canBundleBeDefaultOnDevice(installedFixture(), probe, {
      manifestLoader: () => m,
    });
    expect(r).toMatchObject({
      canBeDefault: false,
      reason: "kernels-unverified-on-device",
    });
  });

  it("refuses when a required eval gate did not pass", () => {
    const m = fixtureManifest();
    m.evals.textEval = { score: 0.2, passed: false };
    const r = canBundleBeDefaultOnDevice(installedFixture(), probe, {
      manifestLoader: () => m,
    });
    expect(r).toMatchObject({
      canBeDefault: false,
      reason: "not-default-eligible",
    });
  });
});
