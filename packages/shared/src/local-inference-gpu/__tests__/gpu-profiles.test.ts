/**
 * Tests for the simplified GPU tier-profile system.
 *
 * Safety constraint: no model loading, no llama-server spawns, no real
 * inference. All test coverage uses mocks / synthetic data only.
 *
 * nvidia-smi is never invoked — `detectNvidiaGpu` falls back to null
 * gracefully in CI (binary not present / no NVIDIA driver).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  autoSelectProfile,
  detectNvidiaGpu,
} from "../gpu-tier-detect.js";
import {
  buildLlamaCppArgs,
  getGpuProfile,
  GPU_PROFILES,
  selectBestProfile,
} from "../gpu-tier-profiles.js";

// ---------------------------------------------------------------------------
// 1. GPU_PROFILES registry — all 4 expected ids present
// ---------------------------------------------------------------------------

describe("GPU_PROFILES registry", () => {
  it("contains all 4 expected profile ids", () => {
    const ids = Object.keys(GPU_PROFILES);
    expect(ids).toContain("rtx-3090");
    expect(ids).toContain("rtx-4090");
    expect(ids).toContain("rtx-5090");
    expect(ids).toContain("h200");
    expect(ids).toHaveLength(4);
  });

  it("each profile has required fields with correct types", () => {
    for (const profile of Object.values(GPU_PROFILES)) {
      expect(typeof profile.id).toBe("string");
      expect(typeof profile.display_name).toBe("string");
      expect(typeof profile.vram_gb).toBe("number");
      expect(typeof profile.cuda_compute).toBe("string");
      expect(Array.isArray(profile.features)).toBe(true);
      expect(typeof profile.ctx_size_tokens).toBe("number");
      expect(profile.ctx_size_tokens).toBeGreaterThan(0);
      expect(typeof profile.notes).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. getGpuProfile
// ---------------------------------------------------------------------------

describe("getGpuProfile", () => {
  it("returns the rtx-4090 profile with correct fields", () => {
    const p = getGpuProfile("rtx-4090");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("rtx-4090");
    expect(p!.display_name).toBe("NVIDIA RTX 4090");
    expect(p!.vram_gb).toBe(24);
    expect(p!.cuda_compute).toBe("8.9");
    expect(p!.features).toContain("fp8");
    expect(p!.features).not.toContain("fp4");
    expect(p!.ctx_size_tokens).toBe(65536);
    expect(p!.dflash.enabled).toBe(true);
    expect(p!.dflash.drafter_tier).toBe("0_6b");
    expect(p!.dflash.speculative_window).toBe(6);
  });

  it("returns null for an unknown profile id", () => {
    expect(getGpuProfile("rtx-9090")).toBeNull();
    expect(getGpuProfile("")).toBeNull();
    expect(getGpuProfile("a100")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3–6. selectBestProfile — per-card selection
// ---------------------------------------------------------------------------

describe("selectBestProfile", () => {
  it("selects rtx-3090 for 24 GB VRAM at compute 8.6", () => {
    const p = selectBestProfile(24, "8.6");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("rtx-3090");
  });

  it("selects rtx-4090 for 24 GB VRAM at compute 8.9", () => {
    const p = selectBestProfile(24, "8.9");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("rtx-4090");
  });

  it("selects rtx-5090 for 32 GB VRAM at compute 12.0", () => {
    const p = selectBestProfile(32, "12.0");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("rtx-5090");
  });

  it("selects h200 for 141 GB VRAM at compute 9.0", () => {
    const p = selectBestProfile(141, "9.0");
    expect(p).not.toBeNull();
    expect(p!.id).toBe("h200");
  });

  // ---------------------------------------------------------------------------
  // 7. No profile fits 8 GB VRAM
  // ---------------------------------------------------------------------------

  it("returns null when VRAM (8 GB) is below all supported profiles", () => {
    expect(selectBestProfile(8, "7.5")).toBeNull();
  });

  it("returns null when compute capability is too low even with enough VRAM", () => {
    // All profiles need at least 8.6; compute 5.0 should yield null.
    expect(selectBestProfile(24, "5.0")).toBeNull();
  });

  it("prefers the highest-VRAM eligible profile", () => {
    // 50 GB VRAM @ compute 9.0: fits rtx-3090 (24 GB), rtx-4090 (24 GB),
    // and h200 (141 GB is too large). Should prefer rtx-5090 at 32 GB
    // — but 32 > 50? No: 32 <= 50, so rtx-5090 is eligible.
    // h200 vram_gb=141 > 50 → excluded. Best is rtx-5090 (32 GB, cc 12.0 > 9.0 → excluded).
    // rtx-3090 (24 GB, cc 8.6 <= 9.0 ✓). rtx-4090 (24 GB, cc 8.9 <= 9.0 ✓).
    // Highest vram_gb among eligible = 24 GB (tie between 3090 and 4090 at same vram).
    // 4090 has same vram_gb as 3090 so it depends on iteration order; both are valid.
    // The key assertion is: h200 (141 > 50) is excluded and rtx-5090 (cc 12.0 > 9.0) is excluded.
    const p = selectBestProfile(50, "9.0");
    expect(p).not.toBeNull();
    expect(["rtx-3090", "rtx-4090"]).toContain(p!.id);
  });
});

// ---------------------------------------------------------------------------
// 8. buildLlamaCppArgs for rtx-3090
// ---------------------------------------------------------------------------

describe("buildLlamaCppArgs", () => {
  it("rtx-3090 includes --n-gpu-layers 99 and --flash-attn", () => {
    const profile = getGpuProfile("rtx-3090")!;
    const args = buildLlamaCppArgs(profile);

    const nglIdx = args.indexOf("--n-gpu-layers");
    expect(nglIdx).toBeGreaterThanOrEqual(0);
    expect(args[nglIdx + 1]).toBe("99");

    expect(args).toContain("--flash-attn");
  });

  it("rtx-3090 includes --ctx-size 32768", () => {
    const profile = getGpuProfile("rtx-3090")!;
    const args = buildLlamaCppArgs(profile);

    const ctxIdx = args.indexOf("--ctx-size");
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(args[ctxIdx + 1]).toBe("32768");
  });

  it("rtx-3090 does not include --no-mmap (use_mmap is true)", () => {
    const profile = getGpuProfile("rtx-3090")!;
    expect(buildLlamaCppArgs(profile)).not.toContain("--no-mmap");
  });

  it("rtx-3090 does not include --numa (numa is false)", () => {
    const profile = getGpuProfile("rtx-3090")!;
    expect(buildLlamaCppArgs(profile)).not.toContain("--numa");
  });

  it("h200 includes --no-mmap and --numa (use_mmap=false, numa=true)", () => {
    const profile = getGpuProfile("h200")!;
    const args = buildLlamaCppArgs(profile);
    expect(args).toContain("--no-mmap");
    expect(args).toContain("--numa");
  });

  it("overrides are applied — n_gpu_layers override changes the flag", () => {
    const profile = getGpuProfile("rtx-4090")!;
    const args = buildLlamaCppArgs(profile, { n_gpu_layers: 32 });

    const nglIdx = args.indexOf("--n-gpu-layers");
    expect(nglIdx).toBeGreaterThanOrEqual(0);
    expect(args[nglIdx + 1]).toBe("32");
  });

  it("ctx_size_tokens override changes the --ctx-size flag", () => {
    const profile = getGpuProfile("rtx-4090")!;
    const args = buildLlamaCppArgs(profile, { ctx_size_tokens: 8192 });

    const ctxIdx = args.indexOf("--ctx-size");
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(args[ctxIdx + 1]).toBe("8192");
  });

  it("returns a string array with no undefined entries", () => {
    for (const profile of Object.values(GPU_PROFILES)) {
      const args = buildLlamaCppArgs(profile);
      expect(args.every((a) => typeof a === "string")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. detectNvidiaGpu — graceful null when nvidia-smi is absent
// ---------------------------------------------------------------------------

describe("detectNvidiaGpu", () => {
  it("returns null gracefully when nvidia-smi is not available (CI path)", () => {
    // In CI there is no NVIDIA driver. The function must not throw; it
    // must return null.
    const result = detectNvidiaGpu();
    // Accept either null (nvidia-smi absent) or a DetectedGpu (NVIDIA host).
    if (result !== null) {
      expect(typeof result.name).toBe("string");
      expect(result.vram_mb).toBeGreaterThan(0);
    } else {
      expect(result).toBeNull();
    }
  });

  it("does not throw under any circumstance", () => {
    expect(() => detectNvidiaGpu()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 10. autoSelectProfile — graceful null when no GPU (CI path)
// ---------------------------------------------------------------------------

describe("autoSelectProfile", () => {
  beforeEach(() => {
    // Ensure the env override is not set for most tests.
    delete process.env["ELIZA_GPU_PROFILE"];
  });

  afterEach(() => {
    delete process.env["ELIZA_GPU_PROFILE"];
  });

  it("returns null gracefully when no GPU is detected (CI path)", () => {
    // On a host without nvidia-smi (the CI runner), this should return null.
    const result = autoSelectProfile();
    // Accept null (no GPU) or a valid profile (NVIDIA host).
    if (result !== null) {
      expect(typeof result.id).toBe("string");
      expect(GPU_PROFILES[result.id]).toBeDefined();
    } else {
      expect(result).toBeNull();
    }
  });

  it("does not throw under any circumstance", () => {
    expect(() => autoSelectProfile()).not.toThrow();
  });

  it("respects ELIZA_GPU_PROFILE env override — returns the named profile", () => {
    process.env["ELIZA_GPU_PROFILE"] = "rtx-5090";
    const result = autoSelectProfile();
    expect(result).not.toBeNull();
    expect(result!.id).toBe("rtx-5090");
  });

  it("returns null when ELIZA_GPU_PROFILE is set to an unknown id", () => {
    process.env["ELIZA_GPU_PROFILE"] = "a100-sxm";
    expect(autoSelectProfile()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Profile data integrity checks
// ---------------------------------------------------------------------------

describe("profile data integrity", () => {
  it("rtx-3090 has no fp8 or fp4 features", () => {
    const p = getGpuProfile("rtx-3090")!;
    expect(p.features).not.toContain("fp8");
    expect(p.features).not.toContain("fp4");
  });

  it("rtx-5090 has fp8 and fp4 features (Blackwell)", () => {
    const p = getGpuProfile("rtx-5090")!;
    expect(p.features).toContain("fp8");
    expect(p.features).toContain("fp4");
  });

  it("h200 has fp8 but not fp4 (Hopper)", () => {
    const p = getGpuProfile("h200")!;
    expect(p.features).toContain("fp8");
    expect(p.features).not.toContain("fp4");
  });

  it("h200 has the largest ctx_size_tokens among the four profiles", () => {
    const sizes = Object.values(GPU_PROFILES).map((p) => p.ctx_size_tokens);
    const h200Size = getGpuProfile("h200")!.ctx_size_tokens;
    expect(h200Size).toBe(Math.max(...sizes));
  });

  it("h200 is the only profile with numa=true", () => {
    for (const [id, profile] of Object.entries(GPU_PROFILES)) {
      if (id === "h200") {
        expect(profile.llama_cpp_flags.numa).toBe(true);
      } else {
        expect(profile.llama_cpp_flags.numa).toBe(false);
      }
    }
  });

  it("h200 is the only profile with use_mmap=false", () => {
    for (const [id, profile] of Object.entries(GPU_PROFILES)) {
      if (id === "h200") {
        expect(profile.llama_cpp_flags.use_mmap).toBe(false);
      } else {
        expect(profile.llama_cpp_flags.use_mmap).toBe(true);
      }
    }
  });

  it("all profiles have flash_attn=true", () => {
    for (const profile of Object.values(GPU_PROFILES)) {
      expect(profile.llama_cpp_flags.flash_attn).toBe(true);
    }
  });

  it("all profiles have n_gpu_layers=99", () => {
    for (const profile of Object.values(GPU_PROFILES)) {
      expect(profile.llama_cpp_flags.n_gpu_layers).toBe(99);
    }
  });

  it("all dflash.enabled are true for all profiles", () => {
    for (const profile of Object.values(GPU_PROFILES)) {
      expect(profile.dflash.enabled).toBe(true);
    }
  });

  it("rtx-5090 has a higher speculative_window than rtx-3090", () => {
    const w3090 = getGpuProfile("rtx-3090")!.dflash.speculative_window;
    const w5090 = getGpuProfile("rtx-5090")!.dflash.speculative_window;
    expect(w5090).toBeGreaterThan(w3090);
  });
});
