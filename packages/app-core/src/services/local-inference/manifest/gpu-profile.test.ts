import { findCatalogModel, GPU_PROFILES } from "@elizaos/shared";
import { describe, expect, it } from "vitest";

describe("catalog gpuProfile wiring", () => {
  it("eliza-1-27b-1m maps to the H200 profile and demands the 1M kernel set", () => {
    const bundle = findCatalogModel("eliza-1-27b-1m");
    expect(bundle).toBeDefined();
    if (!bundle) return;
    expect(bundle.gpuProfile).toBe("h200");
    expect(bundle.contextLength).toBe(1_048_576);
    const required = bundle.runtime?.optimizations?.requiresKernel ?? [];
    // Every kernel needed for 1M-context quantized KV: dflash, turbo3/4,
    // qjl_full, polarquant, and turbo3_tcq (the >64k context guard).
    for (const k of [
      "dflash",
      "turbo3",
      "turbo4",
      "qjl_full",
      "polarquant",
      "turbo3_tcq",
    ]) {
      expect(required).toContain(k);
    }
  });

  it("eliza-1-27b-256k maps to the rtx-5090 profile", () => {
    const bundle = findCatalogModel("eliza-1-27b-256k");
    expect(bundle?.gpuProfile).toBe("rtx-5090");
  });

  it("eliza-1-27b maps to the rtx-4090 profile", () => {
    const bundle = findCatalogModel("eliza-1-27b");
    expect(bundle?.gpuProfile).toBe("rtx-4090");
  });

  it("eliza-1-9b maps to the rtx-3090 profile", () => {
    const bundle = findCatalogModel("eliza-1-9b");
    expect(bundle?.gpuProfile).toBe("rtx-3090");
  });

  it("every recommended bundle id on a profile exists in the catalog", () => {
    for (const profile of Object.values(GPU_PROFILES)) {
      for (const bundleId of profile.recommendedBundles) {
        const bundle = findCatalogModel(bundleId);
        expect(bundle, `bundle ${bundleId} for ${profile.id}`).toBeDefined();
      }
    }
  });

  it("h200 profile's primary bundle covers a 1M context window", () => {
    const profile = GPU_PROFILES.h200;
    const primary = findCatalogModel(profile.recommendedBundles[0]);
    expect(primary?.contextLength).toBe(profile.contextSize);
  });
});
