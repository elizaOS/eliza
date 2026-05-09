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
});
