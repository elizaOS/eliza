/**
 * Unit coverage for normalizing native resource snapshots (thermal/power) from
 * the device bridge. Pure function, no device.
 */
import { describe, expect, it } from "vitest";
import { normalizeResourceSnapshot } from "./resource-snapshot-bridge";

describe("normalizeResourceSnapshot", () => {
  it("passes through a fully-populated Android payload", () => {
    const s = normalizeResourceSnapshot(
      {
        platform: "android",
        thermalState: "fair",
        lowPowerMode: false,
        residentMemoryMb: 812.5,
        availableRamMb: 2048,
        totalRamMb: 7654,
        cpuTimeMs: 12345,
        batteryLevelPct: 73,
        batteryChargeMicroAmpHours: 2_900_000,
        batteryCurrentMicroAmps: -450000,
        isCharging: false,
        capturedAtMs: 1_000,
      },
      9_999,
    );
    expect(s).toEqual({
      platform: "android",
      thermalState: "fair",
      lowPowerMode: false,
      residentMemoryMb: 812.5,
      availableRamMb: 2048,
      totalRamMb: 7654,
      cpuTimeMs: 12345,
      batteryLevelPct: 73,
      batteryChargeMicroAmpHours: 2_900_000,
      batteryCurrentMicroAmps: -450000,
      isCharging: false,
      capturedAtMs: 1_000,
    });
  });

  it("coerces native nulls and missing fields to null (no fabricated zeros)", () => {
    const s = normalizeResourceSnapshot(
      {
        platform: "ios",
        thermalState: "nominal",
        lowPowerMode: true,
        residentMemoryMb: 640,
        availableRamMb: null,
        cpuTimeMs: null,
        batteryLevelPct: null,
        isCharging: true,
        // capturedAtMs missing
      },
      5_555,
    );
    expect(s.availableRamMb).toBeNull();
    expect(s.totalRamMb).toBeNull();
    expect(s.cpuTimeMs).toBeNull();
    expect(s.batteryLevelPct).toBeNull();
    expect(s.batteryChargeMicroAmpHours).toBeNull();
    expect(s.batteryCurrentMicroAmps).toBeNull();
    expect(s.residentMemoryMb).toBe(640);
    expect(s.lowPowerMode).toBe(true);
    expect(s.capturedAtMs).toBe(5_555);
  });

  it("defaults an unknown/garbage thermal state and platform", () => {
    const s = normalizeResourceSnapshot(
      { platform: "web", thermalState: "blazing" },
      42,
    );
    expect(s.platform).toBeNull();
    expect(s.thermalState).toBe("unknown");
  });

  it("treats a non-object payload as all-null with a fallback timestamp", () => {
    const s = normalizeResourceSnapshot(null, 7);
    expect(s.platform).toBeNull();
    expect(s.thermalState).toBe("unknown");
    expect(s.residentMemoryMb).toBeNull();
    expect(s.capturedAtMs).toBe(7);
  });

  it("rejects NaN/Infinity numeric fields", () => {
    const s = normalizeResourceSnapshot(
      {
        platform: "android",
        residentMemoryMb: Number.NaN,
        availableRamMb: Number.POSITIVE_INFINITY,
      },
      1,
    );
    expect(s.residentMemoryMb).toBeNull();
    expect(s.availableRamMb).toBeNull();
  });
});
