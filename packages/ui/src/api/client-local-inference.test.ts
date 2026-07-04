/**
 * Unit coverage for device-tier classification from a hardware probe. Pure
 * function, no harness.
 */
import { describe, expect, it } from "vitest";

import type { HardwareProbe } from "../services/local-inference/types";
import { classifyDeviceTierFromProbe } from "./client-local-inference";

function probe(overrides: Partial<HardwareProbe>): HardwareProbe {
  return {
    totalRamGb: 16,
    freeRamGb: 8,
    gpu: null,
    cpuCores: 8,
    platform: "linux",
    arch: "x64",
    appleSilicon: false,
    recommendedBucket: "mid",
    source: "os-fallback",
    ...overrides,
  };
}

describe("classifyDeviceTierFromProbe", () => {
  it("classifies a high-VRAM dGPU host as MAX", () => {
    const result = classifyDeviceTierFromProbe(
      probe({
        totalRamGb: 64,
        freeRamGb: 32,
        gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 20 },
      }),
    );
    expect(result.tier).toBe("MAX");
    expect(result.cpuOnly).toBe(false);
    expect(result.mobile).toBe(false);
    expect(result.reason).toContain("24 GB VRAM");
  });

  it("classifies a mid dGPU host as GOOD", () => {
    const result = classifyDeviceTierFromProbe(
      probe({
        totalRamGb: 32,
        freeRamGb: 12,
        gpu: { backend: "cuda", totalVramGb: 8, freeVramGb: 6 },
      }),
    );
    expect(result.tier).toBe("GOOD");
  });

  it("classifies a roomy CPU-only x86 host as GOOD", () => {
    const result = classifyDeviceTierFromProbe(
      probe({ totalRamGb: 32, freeRamGb: 12, gpu: null }),
    );
    expect(result.tier).toBe("GOOD");
    expect(result.cpuOnly).toBe(true);
  });

  it("classifies a constrained CPU-only host as OKAY", () => {
    const result = classifyDeviceTierFromProbe(
      probe({ totalRamGb: 16, freeRamGb: 4, gpu: null }),
    );
    expect(result.tier).toBe("OKAY");
  });

  it("classifies a tiny/weak host as POOR", () => {
    const result = classifyDeviceTierFromProbe(
      probe({ totalRamGb: 8, freeRamGb: 1, cpuCores: 2, gpu: null }),
    );
    expect(result.tier).toBe("POOR");
  });

  it("clamps mobile devices to OKAY at best", () => {
    const result = classifyDeviceTierFromProbe(
      probe({
        totalRamGb: 16,
        freeRamGb: 12,
        gpu: { backend: "metal", totalVramGb: 16, freeVramGb: 14 },
        platform: "darwin",
        arch: "arm64",
        appleSilicon: true,
        mobile: { platform: "ios" },
      }),
    );
    expect(result.tier).toBe("OKAY");
    expect(result.mobile).toBe(true);
  });

  it("marks a memory-starved mobile device as POOR", () => {
    const result = classifyDeviceTierFromProbe(
      probe({
        totalRamGb: 4,
        freeRamGb: 1,
        mobile: { platform: "android" },
      }),
    );
    expect(result.tier).toBe("POOR");
    expect(result.mobile).toBe(true);
  });
});
