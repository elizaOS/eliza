/**
 * Tests for the GPU YAML profile zod schema (`gpu-profile-schema.ts`).
 *
 * Real-module harness: every case drives the exported zod schemas and
 * the two catalog-cross-checking helpers directly against the real
 * `ELIZA_1_TIER_IDS` from `local-inference/catalog.js`. No mocks, no
 * YAML file IO, no network.
 */
import { describe, expect, it } from "vitest";

import { ELIZA_1_TIER_IDS } from "../../local-inference/catalog.js";
import {
  BundleRecommendation,
  bundleIdsInProfileMatchCatalog,
  GpuYamlId,
  GpuYamlProfile,
  getRecommendationsByTier,
  KernelName,
  KvCacheType,
  MtpTuning,
  VerifyRecipe,
} from "../gpu-profile-schema.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBundle(overrides: Record<string, unknown> = {}) {
  return {
    n_gpu_layers: 99,
    ctx_size: 32768,
    parallel: 1,
    batch_size: 512,
    ubatch_size: 512,
    kv_cache_k: "q8_0",
    kv_cache_v: "f16",
    flash_attention: true,
    estimated_decode_tps: 40.5,
    estimated_prefill_tps: 900.1,
    ...overrides,
  };
}

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    gpu_id: "rtx-3090",
    gpu_arch: "sm_86",
    vram_gb: 24,
    mem_bandwidth_gbps: 936.2,
    fp8_supported: false,
    fp4_supported: false,
    nvlink: false,
    bundle_recommendations: {
      [ELIZA_1_TIER_IDS[0]]: makeBundle(),
    },
    mtp: {
      enabled: true,
      draft_min: 2,
      draft_max: 6,
      draft_gpu_layers: 10,
    },
    verify_recipe: {
      build_target: "llama-server",
      cuda_arch: 86,
      cmake_flags: ["-DGGML_CUDA=ON"],
      expected_kernels: ["mtp"],
      smoke_bundle: ELIZA_1_TIER_IDS[0],
      tolerance_pct: 10,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. GpuYamlId — card id enum
// ---------------------------------------------------------------------------

describe("GpuYamlId", () => {
  it("accepts each of the four card ids", () => {
    expect(GpuYamlId.parse("rtx-3090")).toBe("rtx-3090");
    expect(GpuYamlId.parse("rtx-4090")).toBe("rtx-4090");
    expect(GpuYamlId.parse("rtx-5090")).toBe("rtx-5090");
    expect(GpuYamlId.parse("h200")).toBe("h200");
  });

  it("rejects unknown card ids", () => {
    expect(GpuYamlId.safeParse("a100").success).toBe(false);
    expect(GpuYamlId.safeParse("").success).toBe(false);
    expect(GpuYamlId.safeParse(undefined).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. KvCacheType / KernelName enums
// ---------------------------------------------------------------------------

describe("KvCacheType", () => {
  it("accepts every documented cache-type string", () => {
    for (const value of [
      "f16",
      "q8_0",
      "q4_0",
      "qjl1_256",
      "q4_polar",
      "turbo3_0",
      "turbo4_0",
    ]) {
      expect(KvCacheType.parse(value)).toBe(value);
    }
  });

  it("rejects undocumented and differently-cased cache types", () => {
    expect(KvCacheType.safeParse("f32").success).toBe(false);
    expect(KvCacheType.safeParse("F16").success).toBe(false);
    expect(KvCacheType.safeParse("").success).toBe(false);
  });
});

describe("KernelName", () => {
  it("accepts every documented kernel name", () => {
    for (const value of [
      "mtp",
      "turbo3",
      "turbo4",
      "turbo3_tcq",
      "qjl_full",
      "polarquant",
    ]) {
      expect(KernelName.parse(value)).toBe(value);
    }
  });

  it("rejects unknown kernel names", () => {
    expect(KernelName.safeParse("mtp2").success).toBe(false);
    expect(KernelName.safeParse("").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. BundleRecommendation
// ---------------------------------------------------------------------------

describe("BundleRecommendation", () => {
  it("parses a complete bundle and preserves every field", () => {
    const input = makeBundle({ mlock: true, notes: "baseline" });
    const parsed = BundleRecommendation.parse(input);
    expect(parsed).toEqual({
      n_gpu_layers: 99,
      ctx_size: 32768,
      parallel: 1,
      batch_size: 512,
      ubatch_size: 512,
      kv_cache_k: "q8_0",
      kv_cache_v: "f16",
      flash_attention: true,
      mlock: true,
      estimated_decode_tps: 40.5,
      estimated_prefill_tps: 900.1,
      notes: "baseline",
    });
  });

  it("treats mlock and notes as optional", () => {
    const parsed = BundleRecommendation.parse(makeBundle());
    expect(parsed.mlock).toBeUndefined();
    expect(parsed.notes).toBeUndefined();
  });

  it("requires every mandatory numeric field", () => {
    const required: Array<keyof ReturnType<typeof makeBundle>> = [
      "n_gpu_layers",
      "ctx_size",
      "parallel",
      "batch_size",
      "ubatch_size",
      "estimated_decode_tps",
      "estimated_prefill_tps",
    ];
    for (const field of required) {
      const partial = makeBundle();
      delete partial[field];
      expect(
        BundleRecommendation.safeParse(partial).success,
        `expected missing ${field} to fail`,
      ).toBe(false);
    }
  });

  it("requires the KV cache fields and boolean flash_attention", () => {
    expect(
      BundleRecommendation.safeParse(makeBundle({ kv_cache_k: undefined }))
        .success,
    ).toBe(false);
    expect(
      BundleRecommendation.safeParse(makeBundle({ kv_cache_v: undefined }))
        .success,
    ).toBe(false);
    expect(
      BundleRecommendation.safeParse(makeBundle({ flash_attention: "yes" }))
        .success,
    ).toBe(false);
  });

  it("enforces positive integers for sizing fields", () => {
    expect(
      BundleRecommendation.safeParse(makeBundle({ ctx_size: 0 })).success,
    ).toBe(false);
    expect(
      BundleRecommendation.safeParse(makeBundle({ ctx_size: -1 })).success,
    ).toBe(false);
    expect(
      BundleRecommendation.safeParse(makeBundle({ parallel: 0 })).success,
    ).toBe(false);
    expect(
      BundleRecommendation.safeParse(makeBundle({ batch_size: 0 })).success,
    ).toBe(false);
    expect(
      BundleRecommendation.safeParse(makeBundle({ ubatch_size: 0 })).success,
    ).toBe(false);
  });

  it("requires n_gpu_layers to be an integer but allows any sign", () => {
    expect(
      BundleRecommendation.safeParse(makeBundle({ n_gpu_layers: 1.5 })).success,
    ).toBe(false);
    expect(
      BundleRecommendation.safeParse(makeBundle({ n_gpu_layers: 0 })).success,
    ).toBe(true);
  });

  it("requires strictly positive throughput estimates", () => {
    expect(
      BundleRecommendation.safeParse(makeBundle({ estimated_decode_tps: 0 }))
        .success,
    ).toBe(false);
    expect(
      BundleRecommendation.safeParse(makeBundle({ estimated_decode_tps: -3 }))
        .success,
    ).toBe(false);
    expect(
      BundleRecommendation.safeParse(makeBundle({ estimated_prefill_tps: 0 }))
        .success,
    ).toBe(false);
  });

  it("validates KV cache values against the enum", () => {
    expect(
      BundleRecommendation.safeParse(makeBundle({ kv_cache_k: "f32" })).success,
    ).toBe(false);
    expect(
      BundleRecommendation.safeParse(makeBundle({ kv_cache_v: "qjl9_9" }))
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. MtpTuning
// ---------------------------------------------------------------------------

describe("MtpTuning", () => {
  it("parses a valid tuning block", () => {
    expect(
      MtpTuning.parse({
        enabled: true,
        draft_min: 2,
        draft_max: 6,
        draft_gpu_layers: 10,
      }),
    ).toEqual({
      enabled: true,
      draft_min: 2,
      draft_max: 6,
      draft_gpu_layers: 10,
    });
  });

  it("rejects zero or negative draft bounds", () => {
    expect(
      MtpTuning.safeParse({
        enabled: true,
        draft_min: 0,
        draft_max: 6,
        draft_gpu_layers: 1,
      }).success,
    ).toBe(false);
    expect(
      MtpTuning.safeParse({
        enabled: true,
        draft_min: 2,
        draft_max: -6,
        draft_gpu_layers: 1,
      }).success,
    ).toBe(false);
  });

  it("allows any integer sign for draft_gpu_layers (int constraint only)", () => {
    expect(
      MtpTuning.safeParse({
        enabled: true,
        draft_min: 2,
        draft_max: 6,
        draft_gpu_layers: -1,
      }).success,
    ).toBe(true);
    expect(
      MtpTuning.safeParse({
        enabled: true,
        draft_min: 2,
        draft_max: 6,
        draft_gpu_layers: 1.5,
      }).success,
    ).toBe(false);
  });

  it("requires enabled to be a real boolean", () => {
    expect(
      MtpTuning.safeParse({
        enabled: "true",
        draft_min: 2,
        draft_max: 6,
        draft_gpu_layers: 1,
      }).success,
    ).toBe(false);
  });

  it("requires every field", () => {
    expect(
      MtpTuning.safeParse({ enabled: true, draft_min: 2, draft_max: 6 })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. VerifyRecipe
// ---------------------------------------------------------------------------

describe("VerifyRecipe", () => {
  it("defaults unavailable_kernels to an empty array when omitted", () => {
    const parsed = VerifyRecipe.parse({
      build_target: "llama-server",
      cuda_arch: 120,
      cmake_flags: ["-DGGML_CUDA=ON"],
      expected_kernels: ["turbo3"],
      smoke_bundle: "eliza-1-4b",
      tolerance_pct: 15,
    });
    expect(parsed.unavailable_kernels).toEqual([]);
  });

  it("preserves a provided unavailable_kernels list", () => {
    const parsed = VerifyRecipe.parse({
      build_target: "llama-server",
      cuda_arch: 120,
      cmake_flags: ["-DGGML_CUDA=ON"],
      expected_kernels: ["turbo4"],
      unavailable_kernels: ["qjl_full", "polarquant"],
      warn_on_kernel_absent: true,
      smoke_bundle: "eliza-1-4b",
      tolerance_pct: 15,
    });
    expect(parsed.unavailable_kernels).toEqual(["qjl_full", "polarquant"]);
    expect(parsed.warn_on_kernel_absent).toBe(true);
  });

  it("requires at least one cmake flag and one expected kernel", () => {
    const base = {
      build_target: "llama-server",
      cuda_arch: 86,
      expected_kernels: ["mtp"],
      smoke_bundle: "eliza-1-2b",
      tolerance_pct: 10,
    };
    expect(VerifyRecipe.safeParse({ ...base, cmake_flags: [] }).success).toBe(
      false,
    );
    expect(
      VerifyRecipe.safeParse({ ...base, cmake_flags: ["-DGGML_CUDA=ON"] })
        .success,
    ).toBe(true);
    expect(
      VerifyRecipe.safeParse({ ...base, expected_kernels: [] }).success,
    ).toBe(false);
  });

  it("validates kernel entries against KernelName", () => {
    expect(
      VerifyRecipe.safeParse({
        build_target: "llama-server",
        cuda_arch: 86,
        cmake_flags: ["-DGGML_CUDA=ON"],
        expected_kernels: ["warp9"],
        smoke_bundle: "eliza-1-2b",
        tolerance_pct: 10,
      }).success,
    ).toBe(false);
  });

  it("requires a positive cuda_arch and tolerance_pct", () => {
    const base = {
      build_target: "llama-server",
      cmake_flags: ["-DGGML_CUDA=ON"],
      expected_kernels: ["mtp"],
      smoke_bundle: "eliza-1-2b",
      tolerance_pct: 10,
    };
    expect(VerifyRecipe.safeParse({ ...base, cuda_arch: 0 }).success).toBe(
      false,
    );
    expect(VerifyRecipe.safeParse({ ...base, tolerance_pct: 0 }).success).toBe(
      false,
    );
  });

  it("requires build_target and smoke_bundle strings", () => {
    expect(
      VerifyRecipe.safeParse({
        cuda_arch: 86,
        cmake_flags: ["-DGGML_CUDA=ON"],
        expected_kernels: ["mtp"],
        smoke_bundle: "eliza-1-2b",
        tolerance_pct: 10,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. GpuYamlProfile — the full document schema
// ---------------------------------------------------------------------------

describe("GpuYamlProfile", () => {
  it("round-trips a complete valid profile", () => {
    const input = makeProfile();
    // unavailable_kernels is omitted in the fixture; its zod default
    // materialises as [] in the parse output.
    expect(GpuYamlProfile.parse(input)).toEqual({
      ...input,
      verify_recipe: { ...input.verify_recipe, unavailable_kernels: [] },
    });
  });

  it("accepts an empty bundle_recommendations record", () => {
    const parsed = GpuYamlProfile.parse(
      makeProfile({ bundle_recommendations: {} }),
    );
    expect(parsed.bundle_recommendations).toEqual({});
  });

  it("enforces the sm_XX arch format", () => {
    expect(
      GpuYamlProfile.safeParse(makeProfile({ gpu_arch: "sm_120" })).success,
    ).toBe(true);
    expect(
      GpuYamlProfile.safeParse(makeProfile({ gpu_arch: "sm_8" })).success,
    ).toBe(false);
    expect(
      GpuYamlProfile.safeParse(makeProfile({ gpu_arch: "8_6" })).success,
    ).toBe(false);
    expect(
      GpuYamlProfile.safeParse(makeProfile({ gpu_arch: "sm_" })).success,
    ).toBe(false);
  });

  it("requires positive vram_gb and mem_bandwidth_gbps", () => {
    expect(GpuYamlProfile.safeParse(makeProfile({ vram_gb: 0 })).success).toBe(
      false,
    );
    expect(
      GpuYamlProfile.safeParse(makeProfile({ vram_gb: -24 })).success,
    ).toBe(false);
    expect(
      GpuYamlProfile.safeParse(makeProfile({ mem_bandwidth_gbps: 0 })).success,
    ).toBe(false);
  });

  it("requires all four capability booleans", () => {
    for (const field of ["fp8_supported", "fp4_supported", "nvlink"]) {
      const partial = makeProfile();
      delete (partial as Record<string, unknown>)[field];
      expect(
        GpuYamlProfile.safeParse(partial).success,
        `expected missing ${field} to fail`,
      ).toBe(false);
    }
    expect(
      GpuYamlProfile.safeParse(makeProfile({ fp8_supported: "no" })).success,
    ).toBe(false);
  });

  it("rejects an out-of-enum gpu_id", () => {
    expect(
      GpuYamlProfile.safeParse(makeProfile({ gpu_id: "b200" })).success,
    ).toBe(false);
  });

  it("strips unknown top-level keys like a default zod object", () => {
    const parsed = GpuYamlProfile.parse(makeProfile({ future_field: 1 }));
    expect(parsed).not.toHaveProperty("future_field");
  });
});

// ---------------------------------------------------------------------------
// 7. bundleIdsInProfileMatchCatalog
// ---------------------------------------------------------------------------

describe("bundleIdsInProfileMatchCatalog", () => {
  it("returns ok for profiles whose bundle ids are all real tier ids", () => {
    const result = bundleIdsInProfileMatchCatalog(
      makeProfile({
        bundle_recommendations: {
          [ELIZA_1_TIER_IDS[0]]: makeBundle(),
          [ELIZA_1_TIER_IDS[1]]: makeBundle({ ctx_size: 8192 }),
        },
      }) as never,
    );
    expect(result.ok).toBe(true);
    expect(result.unknown).toEqual([]);
  });

  it("flags a single unknown bundle id without dropping the known ones", () => {
    const result = bundleIdsInProfileMatchCatalog(
      makeProfile({
        bundle_recommendations: {
          [ELIZA_1_TIER_IDS[2]]: makeBundle(),
          "not-a-real-tier": makeBundle(),
        },
      }) as never,
    );
    expect(result.ok).toBe(false);
    expect(result.unknown).toEqual(["not-a-real-tier"]);
  });

  it("lists every unknown id in insertion order", () => {
    const result = bundleIdsInProfileMatchCatalog(
      makeProfile({
        bundle_recommendations: {
          "zzz-new-tier": makeBundle(),
          [ELIZA_1_TIER_IDS[0]]: makeBundle(),
          "aaa-new-tier": makeBundle(),
        },
      }) as never,
    );
    expect(result.unknown).toEqual(["zzz-new-tier", "aaa-new-tier"]);
    expect(result.ok).toBe(false);
  });

  it("returns ok for an empty recommendations record", () => {
    const result = bundleIdsInProfileMatchCatalog(
      makeProfile({ bundle_recommendations: {} }) as never,
    );
    expect(result.ok).toBe(true);
    expect(result.unknown).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. getRecommendationsByTier
// ---------------------------------------------------------------------------

describe("getRecommendationsByTier", () => {
  it("maps known tier ids to their recommendation objects", () => {
    const bundleA = makeBundle();
    const bundleB = makeBundle({ ctx_size: 16384 });
    const profile = makeProfile({
      bundle_recommendations: {
        [ELIZA_1_TIER_IDS[0]]: bundleA,
        [ELIZA_1_TIER_IDS[3]]: bundleB,
      },
    }) as never;
    const byTier = getRecommendationsByTier(profile);
    expect(byTier[ELIZA_1_TIER_IDS[0]]).toBe(bundleA);
    expect(byTier[ELIZA_1_TIER_IDS[3]]).toBe(bundleB);
    expect(Object.keys(byTier)).toHaveLength(2);
  });

  it("drops bundle ids that are not catalog tier ids", () => {
    const bundleA = makeBundle();
    const byTier = getRecommendationsByTier(
      makeProfile({
        bundle_recommendations: {
          [ELIZA_1_TIER_IDS[1]]: bundleA,
          "future-tier-99b": makeBundle(),
        },
      }) as never,
    );
    expect(Object.keys(byTier)).toEqual([ELIZA_1_TIER_IDS[1]]);
    expect("future-tier-99b" in byTier).toBe(false);
  });

  it("returns an empty mapping for an empty recommendations record", () => {
    const byTier = getRecommendationsByTier(
      makeProfile({ bundle_recommendations: {} }) as never,
    );
    expect(byTier).toEqual({});
  });
});
