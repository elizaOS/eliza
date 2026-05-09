import { describe, expect, it } from "vitest";
import {
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
