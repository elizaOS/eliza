/**
 * Unit tests for GPU inference hardware profiles and name matching.
 * Validates card profile specifications, headroom calculation, and name matcher heuristics.
 */
import { describe, expect, it } from "vitest";
import {
  GPU_PROFILE_IDS,
  GPU_PROFILES,
  matchGpuProfile,
  reservedHeadroomGb,
} from "../gpu-profiles.ts";

describe("gpu-profiles", () => {
  describe("GPU_PROFILES and GPU_PROFILE_IDS", () => {
    it("registers all 4 supported GPU profiles", () => {
      expect(GPU_PROFILE_IDS).toEqual([
        "rtx-3090",
        "rtx-4090",
        "rtx-5090",
        "h200",
      ]);
      expect(Object.keys(GPU_PROFILES)).toHaveLength(4);
    });

    it("has correct hardware attributes for RTX 4090", () => {
      const rtx4090 = GPU_PROFILES["rtx-4090"];
      expect(rtx4090.displayName).toBe("NVIDIA GeForce RTX 4090");
      expect(rtx4090.vramGb).toBe(24);
      expect(rtx4090.computeCapability).toBe("sm_89");
      expect(rtx4090.fp8).toBe(true);
      expect(rtx4090.recommendedBundles).toContain("eliza-1-27b");
    });

    it("has correct hardware attributes for H200", () => {
      const h200 = GPU_PROFILES.h200;
      expect(h200.displayName).toBe("NVIDIA H200 (SXM 141 GiB)");
      expect(h200.vramGb).toBe(141);
      expect(h200.computeCapability).toBe("sm_90");
      expect(h200.memoryBandwidthGBs).toBe(4800);
    });
  });

  describe("matchGpuProfile", () => {
    it("matches NVIDIA card names correctly", () => {
      expect(matchGpuProfile("NVIDIA GeForce RTX 4090")).toBe("rtx-4090");
      expect(matchGpuProfile("NVIDIA GeForce RTX 3090 Ti")).toBe("rtx-3090");
      expect(matchGpuProfile("NVIDIA GeForce RTX 5090")).toBe("rtx-5090");
      expect(matchGpuProfile("NVIDIA H200 141GB HBM3e")).toBe("h200");
      expect(matchGpuProfile("rtx4090")).toBe("rtx-4090");
    });

    it("returns null for unsupported or non-matching card names", () => {
      expect(matchGpuProfile("NVIDIA GeForce GTX 1080")).toBeNull();
      expect(matchGpuProfile("NVIDIA RTX A6000")).toBeNull();
      expect(matchGpuProfile("Apple M2 Max")).toBeNull();
      expect(matchGpuProfile("")).toBeNull();
    });
  });

  describe("reservedHeadroomGb", () => {
    it("returns correct headroom reserve for each profile", () => {
      expect(reservedHeadroomGb(GPU_PROFILES["rtx-3090"])).toBe(3);
      expect(reservedHeadroomGb(GPU_PROFILES["rtx-4090"])).toBe(3);
      expect(reservedHeadroomGb(GPU_PROFILES["rtx-5090"])).toBe(4);
      expect(reservedHeadroomGb(GPU_PROFILES.h200)).toBe(6);
    });
  });
});
