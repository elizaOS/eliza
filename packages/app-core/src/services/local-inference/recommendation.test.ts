import { describe, expect, it } from "vitest";
import { findCatalogModel } from "./catalog";
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
  it("prefers the largest fitting DFlash target on Linux GPU", () => {
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
    expect(recommended.TEXT_SMALL.model?.id).toBe("qwen3.5-4b-dflash");
    expect(recommended.TEXT_LARGE.model?.id).toBe("qwen3.6-27b-dflash");
  });

  it("uses the mobile ladder and still prefers DFlash when it fits", () => {
    const probe = hardware({
      totalRamGb: 8,
      freeRamGb: 5,
      platform: "android" as NodeJS.Platform,
      arch: "arm64",
      recommendedBucket: "small",
    });

    const recommended = selectRecommendedModels(probe);

    expect(classifyRecommendationPlatform(probe)).toBe("mobile");
    expect(recommended.TEXT_SMALL.model?.id).toBe("qwen3.5-4b-dflash");
    expect(recommended.TEXT_LARGE.model?.id).toBe("qwen3.5-4b-dflash");
  });

  it("scales iOS pro-class devices to the largest fitting mobile DFlash target", () => {
    const probe = hardware({
      totalRamGb: 12,
      freeRamGb: 8,
      platform: "ios" as NodeJS.Platform,
      arch: "arm64",
      recommendedBucket: "mid",
    });

    const recommended = selectRecommendedModels(probe);

    expect(classifyRecommendationPlatform(probe)).toBe("mobile");
    expect(recommended.TEXT_SMALL.model?.id).toBe("qwen3.5-4b-dflash");
    expect(recommended.TEXT_LARGE.model?.id).toBe("qwen3.5-9b-dflash");
  });

  it("downshifts iOS below each mobile minspec tier", () => {
    const cases: Array<[number, string | null]> = [
      [4.9, "llama-3.2-3b"],
      [3.9, "smollm2-1.7b"],
      [2.9, "llama-3.2-1b"],
      [1.9, "smollm2-360m"],
      [0.9, null],
    ];

    for (const [totalRamGb, expectedId] of cases) {
      const probe = hardware({
        totalRamGb,
        freeRamGb: Math.max(totalRamGb - 1, 0),
        platform: "ios" as NodeJS.Platform,
        arch: "arm64",
        recommendedBucket: "small",
      });

      expect(selectRecommendedModels(probe).TEXT_LARGE.model?.id ?? null).toBe(
        expectedId,
      );
    }
  });

  it("rejects mobile DFlash when the target plus drafter exceeds the memory guardrail", () => {
    const probe = hardware({
      totalRamGb: 11,
      freeRamGb: 8,
      platform: "ios" as NodeJS.Platform,
      arch: "arm64",
      recommendedBucket: "mid",
    });
    const model = findCatalogModel("qwen3.5-9b-dflash");

    if (!model) throw new Error("qwen3.5-9b-dflash missing from catalog");
    expect(assessCatalogModelFit(probe, model)).toBe("wontfit");
  });

  it("chooses a smaller fitting fallback from the same platform ladder", () => {
    const probe = hardware({
      totalRamGb: 16,
      freeRamGb: 10,
      platform: "linux",
      gpu: null,
      recommendedBucket: "mid",
    });

    const fallback = chooseSmallerFallbackModel(
      "qwen3.6-27b-dflash",
      probe,
      "TEXT_LARGE",
    );

    expect(fallback?.id).toBe("qwen3.5-4b-dflash");
  });

  it("filters DFlash models out of the ladder when the binary lacks dflash kernel", () => {
    const probe = hardware({
      totalRamGb: 64,
      freeRamGb: 48,
      gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
      source: "node-llama-cpp",
    });

    // Stock llama.cpp build — no DFlash, no turbo cache types.
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

    // qwen3.x DFlash entries declare requiresKernel: ["dflash"]; with the
    // stock binary they must drop out of the ladder.
    expect(recommended.TEXT_SMALL.model?.id).not.toMatch(/dflash/);
    expect(recommended.TEXT_LARGE.model?.id).not.toMatch(/dflash/);
  });

  it("still includes DFlash models when no probe is provided (older binaries)", () => {
    const probe = hardware({
      totalRamGb: 64,
      freeRamGb: 48,
      gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
      source: "node-llama-cpp",
    });

    // No options → recommender trusts the catalog.
    const recommended = selectRecommendedModels(probe);
    expect(recommended.TEXT_SMALL.model?.id).toBe("qwen3.5-4b-dflash");
  });

  it("includes DFlash models when the binary advertises the kernel", () => {
    const probe = hardware({
      totalRamGb: 64,
      freeRamGb: 48,
      gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
      source: "node-llama-cpp",
    });

    const forkBinary = {
      dflash: true,
      turbo3: true,
      turbo4: true,
      turbo3_tcq: true,
      qjl_full: false,
      lookahead: true,
      ngramDraft: true,
    };

    const recommended = selectRecommendedModels(probe, undefined, {
      binaryKernels: forkBinary,
    });
    expect(recommended.TEXT_SMALL.model?.id).toBe("qwen3.5-4b-dflash");
    expect(recommended.TEXT_LARGE.model?.id).toBe("qwen3.6-27b-dflash");
  });
});
