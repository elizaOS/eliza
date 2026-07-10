/**
 * Unit coverage for the pure RAM-tier policy (#14390): marketed-GB recovery
 * from raw device totals and the 4/8/12/16 GB boundaries, pinned against
 * real observed device readings. Pure functions, no device.
 */

import { describe, expect, it } from "vitest";
import {
  classifyDeviceRamTier,
  marketedRamGbFromTotalRamMb,
} from "./device-ram-tier";

/** MB reading a device with `kb` kB of MemTotal reports (mirrors totalMem). */
function mbFromKb(kb: number): number {
  return kb / 1024;
}

describe("marketedRamGbFromTotalRamMb", () => {
  it("recovers the marketed size from kernel-reduced readings", () => {
    // Moto G Play 2024, the #14390 device: MemTotal 3,747,844 kB (~3.57 GiB).
    expect(marketedRamGbFromTotalRamMb(mbFromKb(3_747_844))).toBe(4);
    // Pixel 6a class "6 GB" reports ~5.7 GiB.
    expect(marketedRamGbFromTotalRamMb(5.7 * 1024)).toBe(6);
    // "8 GB" phones report ~7.2-7.6 GiB.
    expect(marketedRamGbFromTotalRamMb(7.2 * 1024)).toBe(8);
    expect(marketedRamGbFromTotalRamMb(7.6 * 1024)).toBe(8);
    // "12 GB" / "16 GB" flagships.
    expect(marketedRamGbFromTotalRamMb(11.3 * 1024)).toBe(12);
    expect(marketedRamGbFromTotalRamMb(15.2 * 1024)).toBe(16);
    // An exact power-of-two reading (emulator) is not rounded past itself.
    expect(marketedRamGbFromTotalRamMb(8 * 1024)).toBe(8);
  });

  it("treats unreadable totals as null, never zero", () => {
    expect(marketedRamGbFromTotalRamMb(null)).toBeNull();
    expect(marketedRamGbFromTotalRamMb(undefined)).toBeNull();
    expect(marketedRamGbFromTotalRamMb(0)).toBeNull();
    expect(marketedRamGbFromTotalRamMb(-1)).toBeNull();
    expect(marketedRamGbFromTotalRamMb(Number.NaN)).toBeNull();
    expect(marketedRamGbFromTotalRamMb(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("classifyDeviceRamTier", () => {
  it("blocks every local agent mode under the 4 GB hybrid floor", () => {
    for (const gb of [1, 2, 3]) {
      const a = classifyDeviceRamTier(gb);
      expect(a.tier).toBe("cloud-only");
      expect(a.allowsHybridAgent).toBe(false);
      expect(a.allowsLocalAgent).toBe(false);
      expect(a.allowsLocalModels).toBe(false);
      expect(a.localModelsWarning).toBe(false);
      expect(a.marketedRamGb).toBe(gb);
      expect(a.reason).toContain(`~${gb} GB`);
    }
  });

  it("allows hybrid cloud inference from 4 GB without a device allowlist", () => {
    for (const gb of [4, 6, 7]) {
      const a = classifyDeviceRamTier(gb);
      expect(a.tier).toBe("no-local-models");
      expect(a.allowsHybridAgent).toBe(true);
      expect(a.allowsLocalAgent).toBe(false);
      expect(a.allowsLocalModels).toBe(false);
      expect(a.marketedRamGb).toBe(gb);
    }
  });

  it("allows the agent but blocks on-device models on 8-11 GB", () => {
    for (const gb of [8, 10, 11]) {
      const a = classifyDeviceRamTier(gb);
      expect(a.tier).toBe("no-local-models");
      expect(a.allowsHybridAgent).toBe(true);
      expect(a.allowsLocalAgent).toBe(true);
      expect(a.allowsLocalModels).toBe(false);
      expect(a.localModelsWarning).toBe(false);
    }
  });

  it("allows on-device models with a warning on 12-15 GB", () => {
    for (const gb of [12, 15]) {
      const a = classifyDeviceRamTier(gb);
      expect(a.tier).toBe("local-models-warn");
      expect(a.allowsHybridAgent).toBe(true);
      expect(a.allowsLocalAgent).toBe(true);
      expect(a.allowsLocalModels).toBe(true);
      expect(a.localModelsWarning).toBe(true);
    }
  });

  it("is unrestricted from 16 GB up", () => {
    for (const gb of [16, 24, 64]) {
      const a = classifyDeviceRamTier(gb);
      expect(a.tier).toBe("full-local");
      expect(a.allowsHybridAgent).toBe(true);
      expect(a.allowsLocalAgent).toBe(true);
      expect(a.allowsLocalModels).toBe(true);
      expect(a.localModelsWarning).toBe(false);
    }
  });

  it("classifies an unreadable total as the explicit unknown tier that gates nothing", () => {
    const a = classifyDeviceRamTier(null);
    expect(a.tier).toBe("unknown");
    expect(a.marketedRamGb).toBeNull();
    expect(a.allowsHybridAgent).toBe(true);
    expect(a.allowsLocalAgent).toBe(true);
    expect(a.allowsLocalModels).toBe(true);
    expect(a.localModelsWarning).toBe(false);
  });
});
