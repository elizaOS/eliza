/**
 * Tests for GPU deployment profiles, card matching, and headroom calculation.
 */
import { describe, expect, it } from "vitest";
import {
  GPU_PROFILE_IDS,
  GPU_PROFILES,
  type GpuProfile,
  matchGpuProfile,
  reservedHeadroomGb,
} from "./gpu-profiles.ts";

describe("matchGpuProfile", () => {
  it("matches supported GPU models accurately", () => {
    expect(matchGpuProfile("NVIDIA GeForce RTX 3090")).toBe("rtx-3090");
    expect(matchGpuProfile("NVIDIA GeForce RTX 4090")).toBe("rtx-4090");
    expect(matchGpuProfile("NVIDIA RTX4090 D")).toBe("rtx-4090");
    expect(matchGpuProfile("NVIDIA GeForce RTX 5090")).toBe("rtx-5090");
    expect(matchGpuProfile("NVIDIA H200 (SXM 141 GiB)")).toBe("h200");
  });

  it("returns null for unsupported GPUs or invalid inputs", () => {
    expect(matchGpuProfile("NVIDIA GeForce RTX 3080")).toBeNull();
    expect(matchGpuProfile("NVIDIA A100-SXM4-80GB")).toBeNull();
    expect(matchGpuProfile("Apple M2 Max")).toBeNull();
    expect(matchGpuProfile("")).toBeNull();
    expect(matchGpuProfile(null)).toBeNull();
    expect(matchGpuProfile(undefined)).toBeNull();
  });
});

describe("reservedHeadroomGb", () => {
  it("calculates reserved headroom correctly per profile", () => {
    expect(reservedHeadroomGb(GPU_PROFILES["rtx-3090"])).toBe(3);
    expect(reservedHeadroomGb(GPU_PROFILES["rtx-4090"])).toBe(3);
    expect(reservedHeadroomGb(GPU_PROFILES["rtx-5090"])).toBe(4);
    expect(reservedHeadroomGb(GPU_PROFILES.h200)).toBe(6);
  });

  it("returns default headroom for nullish or invalid profiles", () => {
    expect(reservedHeadroomGb(null)).toBe(3);
    expect(reservedHeadroomGb(undefined)).toBe(3);
    expect(reservedHeadroomGb({} as GpuProfile)).toBe(3);
  });
});

describe("GPU_PROFILES and GPU_PROFILE_IDS", () => {
  it("contains all listed profile IDs with complete configuration properties", () => {
    for (const id of GPU_PROFILE_IDS) {
      const profile = GPU_PROFILES[id];
      expect(profile).toBeDefined();
      expect(profile.id).toBe(id);
      expect(profile.vramGb).toBeGreaterThan(0);
      expect(profile.computeCapability).toMatch(/^sm_\d+$/);
      expect(profile.recommendedBundles.length).toBeGreaterThan(0);
      expect(profile.parallel).toBeGreaterThan(0);
      expect(profile.batchSize).toBeGreaterThan(0);
      expect(profile.ubatchSize).toBeGreaterThan(0);
      expect(profile.kvCacheTypeK).toBeDefined();
      expect(profile.kvCacheTypeV).toBeDefined();
    }
  });
});
