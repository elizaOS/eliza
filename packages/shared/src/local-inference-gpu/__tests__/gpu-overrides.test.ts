/**
 * Tests for the CUDA runtime hand-off patch builder in gpu-overrides.
 *
 * Harness is deterministic: the real `getGpuOverrides` module is driven
 * against fully-typed synthetic YAML profiles. No IO, no llama-server,
 * no model loading — the function under test is documented as pure.
 */
import { describe, expect, it } from "vitest";

import {
  getGpuOverrides,
  MTP_SERVER_PATCH_DOCS,
  type MtpServerOverrides,
} from "../gpu-overrides.js";
import type {
  BundleRecommendation,
  GpuYamlProfile,
} from "../gpu-profile-schema.js";

function makeRecommendation(
  overrides?: Partial<BundleRecommendation>,
): BundleRecommendation {
  return {
    n_gpu_layers: 64,
    ctx_size: 32768,
    parallel: 4,
    batch_size: 512,
    ubatch_size: 512,
    kv_cache_k: "q8_0",
    kv_cache_v: "q8_0",
    flash_attention: true,
    estimated_decode_tps: 40,
    estimated_prefill_tps: 900,
    ...overrides,
  };
}

function makeProfile(
  overrides?: Partial<Omit<GpuYamlProfile, "verify_recipe">>,
): GpuYamlProfile {
  return {
    gpu_id: "rtx-4090",
    gpu_arch: "sm_89",
    vram_gb: 24,
    mem_bandwidth_gbps: 1008,
    fp8_supported: true,
    fp4_supported: false,
    nvlink: false,
    bundle_recommendations: {},
    mtp: {
      enabled: true,
      draft_min: 2,
      draft_max: 6,
      draft_gpu_layers: 16,
    },
    verify_recipe: {
      build_target: "llama-server",
      cuda_arch: 89,
      cmake_flags: ["-DGGML_CUDA=ON"],
      expected_kernels: ["mtp"],
      unavailable_kernels: [],
      smoke_bundle: "eliza-1-9b",
      tolerance_pct: 15,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. getGpuOverrides — no-recommendation branches
// ---------------------------------------------------------------------------

describe("getGpuOverrides", () => {
  it("returns no-recommendation when bundle_recommendations is empty", () => {
    const profile = makeProfile();
    const result = getGpuOverrides({
      profile,
      bundleId: "eliza-1-9b",
    });
    expect(result).toEqual({
      kind: "no-recommendation",
      bundleId: "eliza-1-9b",
      gpuId: "rtx-4090",
    });
    expect("overrides" in result).toBe(false);
  });

  it("returns no-recommendation when only non-catalog bundle ids are present", () => {
    const profile = makeProfile({
      bundle_recommendations: {
        "not-a-real-tier": makeRecommendation(),
      },
    });
    const result = getGpuOverrides({
      profile,
      bundleId: "eliza-1-9b",
    });
    expect(result.kind).toBe("no-recommendation");
    if (result.kind === "no-recommendation") {
      expect(result.gpuId).toBe("rtx-4090");
    }
  });

  it("returns no-recommendation when the requested tier differs from available ones", () => {
    const profile = makeProfile({
      bundle_recommendations: {
        "eliza-1-27b": makeRecommendation(),
      },
    });
    const result = getGpuOverrides({
      profile,
      bundleId: "eliza-1-2b",
    });
    expect(result).toEqual({
      kind: "no-recommendation",
      bundleId: "eliza-1-2b",
      gpuId: "rtx-4090",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. getGpuOverrides — applied branch and flag mapping
// ---------------------------------------------------------------------------

describe("getGpuOverrides", () => {
  it("maps every recommendation field onto the MTP override patch", () => {
    const profile = makeProfile({
      bundle_recommendations: {
        "eliza-1-9b": makeRecommendation({
          n_gpu_layers: 99,
          ctx_size: 65536,
          parallel: 2,
          batch_size: 256,
          ubatch_size: 128,
          kv_cache_k: "q4_0",
          kv_cache_v: "f16",
          flash_attention: false,
          mlock: true,
          notes: "synthetic",
        }),
      },
    });
    const result = getGpuOverrides({
      profile,
      bundleId: "eliza-1-9b",
    });
    expect(result.kind).toBe("applied");
    if (result.kind !== "applied") {
      throw new Error("expected applied result");
    }
    expect(result.bundleId).toBe("eliza-1-9b");
    expect(result.gpuId).toBe("rtx-4090");
    const expected: MtpServerOverrides = {
      contextSize: 65536,
      parallel: 2,
      batchSize: 256,
      ubatchSize: 128,
      nGpuLayers: 99,
      flashAttention: false,
      cacheTypeK: "q4_0",
      cacheTypeV: "f16",
      mlock: true,
      draftMin: 2,
      draftMax: 6,
      draftGpuLayers: 16,
    };
    expect(result.overrides).toEqual(expected);
  });

  it("omits mlock when the recommendation leaves it undefined", () => {
    const profile = makeProfile({
      bundle_recommendations: {
        "eliza-1-4b": makeRecommendation(),
      },
    });
    const result = getGpuOverrides({
      profile,
      bundleId: "eliza-1-4b",
    });
    if (result.kind !== "applied") {
      throw new Error("expected applied result");
    }
    expect("mlock" in result.overrides).toBe(false);
  });

  it("omits the draft tuning block when profile.mtp.enabled is false", () => {
    const profile = makeProfile({
      bundle_recommendations: {
        "eliza-1-2b": makeRecommendation({ mlock: false }),
      },
      mtp: {
        enabled: false,
        draft_min: 3,
        draft_max: 9,
        draft_gpu_layers: 8,
      },
    });
    const result = getGpuOverrides({
      profile,
      bundleId: "eliza-1-2b",
    });
    if (result.kind !== "applied") {
      throw new Error("expected applied result");
    }
    expect("draftMin" in result.overrides).toBe(false);
    expect("draftMax" in result.overrides).toBe(false);
    expect("draftGpuLayers" in result.overrides).toBe(false);
    expect(result.overrides.mlock).toBe(false);
  });

  it("passes n_gpu_layers -1 through unchanged (whole model on the single card)", () => {
    const profile = makeProfile({
      bundle_recommendations: {
        "eliza-1-27b": makeRecommendation({ n_gpu_layers: -1 }),
      },
    });
    const result = getGpuOverrides({
      profile,
      bundleId: "eliza-1-27b",
    });
    if (result.kind !== "applied") {
      throw new Error("expected applied result");
    }
    expect(result.overrides.nGpuLayers).toBe(-1);
  });

  it("picks only the requested tier when several recommendations exist", () => {
    const small = makeRecommendation({ ctx_size: 8192 });
    const large = makeRecommendation({ ctx_size: 131072 });
    const profile = makeProfile({
      bundle_recommendations: {
        "eliza-1-2b": small,
        "eliza-1-27b": large,
      },
    });
    const pickedSmall = getGpuOverrides({
      profile,
      bundleId: "eliza-1-2b",
    });
    const pickedLarge = getGpuOverrides({
      profile,
      bundleId: "eliza-1-27b",
    });
    if (pickedSmall.kind !== "applied" || pickedLarge.kind !== "applied") {
      throw new Error("expected applied results");
    }
    expect(pickedSmall.overrides.contextSize).toBe(8192);
    expect(pickedLarge.overrides.contextSize).toBe(131072);
  });

  it("is pure: repeated calls with the same input return equal patches", () => {
    const profile = makeProfile({
      bundle_recommendations: {
        "eliza-1-9b": makeRecommendation(),
      },
    });
    const first = getGpuOverrides({
      profile,
      bundleId: "eliza-1-9b",
    });
    const second = getGpuOverrides({
      profile,
      bundleId: "eliza-1-9b",
    });
    expect(first).toEqual(second);
  });
});

// ---------------------------------------------------------------------------
// 3. MTP_SERVER_PATCH_DOCS — exported integration note stays a string
// ---------------------------------------------------------------------------

describe("MTP_SERVER_PATCH_DOCS", () => {
  it("is a non-empty string constant for integrators to display", () => {
    expect(typeof MTP_SERVER_PATCH_DOCS).toBe("string");
    expect(MTP_SERVER_PATCH_DOCS.length).toBeGreaterThan(0);
  });
});
