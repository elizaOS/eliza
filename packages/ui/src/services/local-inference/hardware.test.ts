import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  assessFit,
  assessOnboardingHardware,
  type OnboardingHardwareAdvice,
} from "./hardware";
import type { HardwareProbe } from "./types";

const GIB = 1024 * 1024 * 1024;

function makeProbe(overrides: Partial<HardwareProbe> = {}): HardwareProbe {
  return {
    totalRamGb: 32,
    freeRamGb: 16,
    gpu: null,
    cpuCores: 8,
    platform: "darwin",
    arch: "arm64",
    appleSilicon: true,
    recommendedBucket: "large",
    source: "os-fallback",
    openvino: {
      runtimeAvailable: false,
      devices: [],
      gpu: {
        renderNodes: [],
        computeRuntimeReady: false,
        missingLinuxPackages: [],
      },
      npu: { accelNodes: [] },
      recommendedAsrDevice: null,
      warnings: [],
    },
    ...overrides,
  };
}

describe("local-inference/hardware — assessFit (existing behavior preserved)", () => {
  it("returns 'fits' when model is well under effective memory", () => {
    expect(assessFit(makeProbe({ totalRamGb: 64 }), 8, 8)).toBe("fits");
  });

  it("returns 'wontfit' when minRamGb exceeds effective memory", () => {
    expect(assessFit(makeProbe({ totalRamGb: 4 }), 2, 8)).toBe("wontfit");
  });

  it("returns 'tight' between 70% and 90% of effective memory", () => {
    expect(assessFit(makeProbe({ totalRamGb: 10 }), 8, 4)).toBe("tight");
  });
});

describe("local-inference/hardware — assessOnboardingHardware", () => {
  it("returns a well-formed advice object on the test runner", async () => {
    const advice: OnboardingHardwareAdvice = await assessOnboardingHardware(
      { sizeBytes: 1 * GIB, ramGbRequired: 1 },
      { workspacePath: tmpdir() },
    );
    expect(advice).toHaveProperty("memory");
    expect(advice).toHaveProperty("disk");
    expect(advice).toHaveProperty("recommended");
    expect(Array.isArray(advice.reasons)).toBe(true);
    expect(["local-ok", "local-with-warning", "cloud-only"]).toContain(
      advice.recommended,
    );
  });

  it("escalates to cloud-only when the runner cannot satisfy a huge model", async () => {
    const advice = await assessOnboardingHardware(
      { sizeBytes: 10 * 1024 * GIB, ramGbRequired: 2048 },
      { workspacePath: tmpdir() },
    );
    expect(advice.recommended).toBe("cloud-only");
    expect(advice.reasons.length).toBeGreaterThan(0);
  });
});
