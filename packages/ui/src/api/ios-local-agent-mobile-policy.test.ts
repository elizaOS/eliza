/**
 * Pins the deterministic mobile model-load choices independently of the native
 * llama bridge and in-renderer route kernel.
 */

import { describe, expect, it } from "vitest";
import type {
  HardwareProbe,
  InstalledModel,
} from "../services/local-inference/types";
import {
  buildMobileLoadOptions,
  mobileRecommendedBucket,
  normalizeMobilePlatform,
} from "./ios-local-agent-mobile-policy";

const installedModel: InstalledModel = {
  id: "unknown-test-model",
  displayName: "Test model",
  path: "/models/test.gguf",
  sizeBytes: 1,
  installedAt: "2026-08-02T00:00:00.000Z",
  lastUsedAt: null,
  source: "eliza-download",
};

function hardware(totalRamGb: number, cpuCores: number): HardwareProbe {
  return {
    totalRamGb,
    freeRamGb: totalRamGb / 2,
    gpu: null,
    cpuCores,
    platform: "darwin",
    arch: "arm64",
    appleSilicon: true,
    recommendedBucket: mobileRecommendedBucket(totalRamGb),
    source: "os-fallback",
    mobile: {
      platform: "ios",
      availableRamGb: totalRamGb / 2,
      gpuSupported: false,
      mtpSupported: true,
      source: "native",
    },
  };
}

describe("iOS local-agent mobile policy", () => {
  it("normalizes unknown web probes to the iOS policy", () => {
    expect(normalizeMobilePlatform("web")).toBe("ios");
    expect(normalizeMobilePlatform("android")).toBe("android");
  });

  it("bounds context, threads, and GPU use from hardware facts", () => {
    expect(
      buildMobileLoadOptions(installedModel, hardware(16, 12)),
    ).toMatchObject({
      modelPath: "/models/test.gguf",
      contextSize: 4096,
      maxThreads: 6,
      useGpu: false,
      draftContextSize: 4096,
      mobileSpeculative: true,
    });
  });

  it("keeps invalid CPU probes from fabricating a thread count", () => {
    expect(
      buildMobileLoadOptions(installedModel, hardware(4, 0)).maxThreads,
    ).toBe(0);
  });
});
