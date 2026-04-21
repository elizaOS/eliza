import { describe, expect, it } from "vitest";
import { assessFit } from "./hardware";
import type { HardwareProbe } from "./types";

function makeProbe(overrides: Partial<HardwareProbe> = {}): HardwareProbe {
  return {
    totalRamGb: 16,
    freeRamGb: 12,
    gpu: null,
    cpuCores: 8,
    platform: "darwin",
    arch: "arm64",
    appleSilicon: true,
    recommendedBucket: "mid",
    source: "node-llama-cpp",
    ...overrides,
  };
}

describe("assessFit", () => {
  it("rejects models that need more RAM than the device has", () => {
    const probe = makeProbe({ totalRamGb: 8, appleSilicon: true });
    // 27B Gemma needs 32 GB per catalog. 8 GB device → wontfit.
    expect(assessFit(probe, 16.6, 32)).toBe("wontfit");
  });

  it("marks models larger than 90% of effective memory as wontfit", () => {
    // 16 GB unified memory → 14.4 GB ceiling; 15 GB model wont fit.
    const probe = makeProbe({ totalRamGb: 16, appleSilicon: true });
    expect(assessFit(probe, 15, 8)).toBe("wontfit");
  });

  it("marks models between 70% and 90% as tight", () => {
    // 32 GB Apple Silicon → 70% = 22.4 GB, 90% = 28.8 GB. 25 GB model → tight.
    const probe = makeProbe({ totalRamGb: 32, appleSilicon: true });
    expect(assessFit(probe, 25, 24)).toBe("tight");
  });

  it("marks small-enough models as fits", () => {
    const probe = makeProbe({ totalRamGb: 32, appleSilicon: true });
    expect(assessFit(probe, 5, 10)).toBe("fits");
  });

  it("favours GPU VRAM on discrete-GPU boxes", () => {
    // 16 GB VRAM, 32 GB RAM, x86. effective = max(16, 32*0.5) = 16 GB.
    // 10 GB model → 63% = fits.
    const probe = makeProbe({
      totalRamGb: 32,
      appleSilicon: false,
      arch: "x64",
      platform: "linux",
      gpu: { backend: "cuda", totalVramGb: 16, freeVramGb: 16 },
    });
    expect(assessFit(probe, 10, 8)).toBe("fits");
    // 15 GB model → 93% of 16 = wontfit.
    expect(assessFit(probe, 15, 8)).toBe("wontfit");
  });

  it("on CPU-only x86, effective memory is half of RAM", () => {
    // 16 GB RAM, no GPU, non-Apple → effective 8 GB.
    // Thresholds: 70% = 5.6, 90% = 7.2.
    const probe = makeProbe({
      totalRamGb: 16,
      appleSilicon: false,
      arch: "x64",
      platform: "linux",
      gpu: null,
    });
    expect(assessFit(probe, 5, 8)).toBe("fits"); // 5 < 5.6
    expect(assessFit(probe, 6, 8)).toBe("tight"); // 5.6 < 6 < 7.2
    expect(assessFit(probe, 8, 8)).toBe("wontfit");
  });
});
