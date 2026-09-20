/**
 * Exercises host GPU detection and profile overrides through the real detector.
 * Detection is a host-dependent smoke check; selection and argv contracts live
 * in gpu-tier-profiles.test.ts. No models or inference servers are loaded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoSelectProfile, detectNvidiaGpu } from "../gpu-tier-detect.js";
import { GPU_PROFILES } from "../gpu-tier-profiles.js";

describe("GPU detection", () => {
  beforeEach(() => vi.stubEnv("ELIZA_GPU_PROFILE", ""));
  afterEach(() => vi.unstubAllEnvs());

  it("detects host metadata or returns null when unavailable", () => {
    const result = detectNvidiaGpu();
    if (result !== null) {
      expect(typeof result.name).toBe("string");
      expect(result.vram_mb).toBeGreaterThan(0);
    }
  });

  it("selects an available profile or returns null on unsupported hosts", () => {
    const result = autoSelectProfile();
    if (result !== null) {
      expect(GPU_PROFILES[result.id]).toBe(result);
    }
  });

  it("honors an explicit profile and rejects unknown overrides", () => {
    vi.stubEnv("ELIZA_GPU_PROFILE", "rtx-5090");
    expect(autoSelectProfile()?.id).toBe("rtx-5090");
    vi.stubEnv("ELIZA_GPU_PROFILE", "a100-sxm");
    expect(autoSelectProfile()).toBeNull();
  });
});
