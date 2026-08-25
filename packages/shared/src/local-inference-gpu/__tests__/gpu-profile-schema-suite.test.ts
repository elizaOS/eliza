/**
 * Unit tests for GPU YAML profile schemas and catalog compatibility validators.
 * Tests schema parsing, tier ID catalog validation, and recommendation filtering.
 */
import { describe, expect, it } from "vitest";
import {
  BundleRecommendation,
  bundleIdsInProfileMatchCatalog,
  GpuYamlId,
  GpuYamlProfile,
  getRecommendationsByTier,
} from "../gpu-profile-schema.ts";

describe("gpu-profile-schema", () => {
  describe("GpuYamlId", () => {
    it("accepts supported GPU identifiers", () => {
      expect(GpuYamlId.safeParse("rtx-3090").success).toBe(true);
      expect(GpuYamlId.safeParse("rtx-4090").success).toBe(true);
      expect(GpuYamlId.safeParse("rtx-5090").success).toBe(true);
      expect(GpuYamlId.safeParse("h200").success).toBe(true);
    });

    it("rejects unknown GPU identifiers", () => {
      expect(GpuYamlId.safeParse("gtx-1080").success).toBe(false);
      expect(GpuYamlId.safeParse("").success).toBe(false);
    });
  });

  describe("BundleRecommendation", () => {
    it("validates a complete bundle recommendation", () => {
      const valid = {
        n_gpu_layers: 33,
        ctx_size: 8192,
        parallel: 1,
        batch_size: 512,
        ubatch_size: 512,
        kv_cache_k: "f16",
        kv_cache_v: "f16",
        flash_attention: true,
        estimated_decode_tps: 85.5,
        estimated_prefill_tps: 450.0,
      };
      expect(BundleRecommendation.safeParse(valid).success).toBe(true);
    });
  });

  describe("GpuYamlProfile", () => {
    it("enforces sm_XX architecture format", () => {
      const profile = {
        gpu_id: "rtx-4090",
        gpu_arch: "sm_89",
        vram_gb: 24,
        mem_bandwidth_gbps: 1008,
        fp8_supported: true,
        fp4_supported: false,
        nvlink: false,
        bundle_recommendations: {},
        mtp: {
          enabled: false,
          draft_min: 1,
          draft_max: 5,
          draft_gpu_layers: 0,
        },
        verify_recipe: {
          build_target: "cuda",
          cuda_arch: 89,
          cmake_flags: ["-DGGML_CUDA=ON"],
          expected_kernels: ["turbo3"],
          smoke_bundle: "small",
          tolerance_pct: 10,
        },
      };
      expect(GpuYamlProfile.safeParse(profile).success).toBe(true);

      const invalidArch = { ...profile, gpu_arch: "invalid_arch" };
      expect(GpuYamlProfile.safeParse(invalidArch).success).toBe(false);
    });
  });

  describe("bundleIdsInProfileMatchCatalog", () => {
    it("reports unknown bundle recommendations", () => {
      const profile = {
        bundle_recommendations: {
          "eliza-1-2b": {} as unknown as BundleRecommendation,
          "nonexistent-bundle": {} as unknown as BundleRecommendation,
        },
      } as unknown as GpuYamlProfile;

      const result = bundleIdsInProfileMatchCatalog(profile);
      expect(result.ok).toBe(false);
      expect(result.unknown).toContain("nonexistent-bundle");
    });
  });

  describe("getRecommendationsByTier", () => {
    it("filters map down to known tier IDs", () => {
      const rec = {
        n_gpu_layers: 33,
        ctx_size: 8192,
        parallel: 1,
        batch_size: 512,
        ubatch_size: 512,
        kv_cache_k: "f16" as const,
        kv_cache_v: "f16" as const,
        flash_attention: true,
        estimated_decode_tps: 85,
        estimated_prefill_tps: 450,
      };

      const profile = {
        bundle_recommendations: {
          "eliza-1-2b": rec,
          "invalid-tier": rec,
        },
      } as unknown as GpuYamlProfile;

      const filtered = getRecommendationsByTier(profile);
      expect(filtered["eliza-1-2b"]).toEqual(rec);
      expect(
        filtered["invalid-tier" as unknown as keyof typeof filtered],
      ).toBeUndefined();
    });
  });
});
