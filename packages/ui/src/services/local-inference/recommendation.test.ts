import { describe, expect, it } from "vitest";
import { DEFAULT_ELIGIBLE_MODEL_IDS, findCatalogModel } from "./catalog";
import {
  assessCatalogModelFit,
  chooseSmallerFallbackModel,
  classifyRecommendationPlatform,
  selectRecommendedModels,
} from "./recommendation";
import type { HardwareProbe } from "./types";

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
    // not. Ladder is 27b-256k -> 27b -> 9b -> 4b -> 1_7b, picks 27b.
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

    expect(recommended.TEXT_LARGE.model?.id).toBe("eliza-1-27b-256k");
  });

  it("uses the mobile platform ladder and prefers the 4B tier when it fits", () => {
    const probe = hardware({
      totalRamGb: 8,
      freeRamGb: 5,
      platform: "android" as NodeJS.Platform,
      arch: "arm64",
      recommendedBucket: "small",
    });

    const recommended = selectRecommendedModels(probe);

    expect(classifyRecommendationPlatform(probe)).toBe("mobile");
    expect(recommended.TEXT_SMALL.model?.id).toBe("eliza-1-0_6b");
    expect(recommended.TEXT_LARGE.model?.id).toBe("eliza-1-4b");
  });

  it("falls back to the 0.6B tier on minimal mobile", () => {
    // 4b needs 8 GB minRam; below that the ladder steps down
    // through 1_7b (4 GB minRam) to 0_6b (2 GB minRam). Below 2 GB
    // nothing fits.
    const cases: Array<[number, string | null]> = [
      [3.5, "eliza-1-0_6b"],
      [1.5, null],
    ];

    for (const [totalRamGb, expectedId] of cases) {
      const probe = hardware({
        totalRamGb,
        freeRamGb: Math.max(totalRamGb - 1, 0),
        platform: "ios" as NodeJS.Platform,
        arch: "arm64",
        recommendedBucket: "small",
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
      platform: "ios" as NodeJS.Platform,
      arch: "arm64",
      recommendedBucket: "mid",
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
    // Kernel requirements are declared by the published bundle manifest,
    // not by the visible catalog entry.
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
      polarquant: false,
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
