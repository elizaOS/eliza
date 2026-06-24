import { describe, expect, it } from "bun:test";
import {
  calculateEndTime,
  getTimeframeFromDuration,
  mapGranularToDbTimeframe,
  TIMEFRAME_CONFIGS,
  validateDuration,
} from "../../engine/src/services/market-timeframes";

/**
 * Market timeframe resolution maps a market's duration to a timeframe bucket and
 * computes its resolution time. The thresholds must be contiguous (no gaps) and
 * end-time must clamp into the timeframe's [min,max] — a market that resolves at
 * the wrong time settles trades incorrectly.
 */

describe("getTimeframeFromDuration", () => {
  it("buckets by the config max-duration thresholds", () => {
    expect(getTimeframeFromDuration(TIMEFRAME_CONFIGS.flash.maxDurationMinutes)).toBe(
      "flash",
    );
    expect(
      getTimeframeFromDuration(TIMEFRAME_CONFIGS.flash.maxDurationMinutes + 1),
    ).toBe("intraday");
    expect(getTimeframeFromDuration(1)).toBe("flash");
    expect(getTimeframeFromDuration(99_999_999)).toBe("longterm");
  });
});

describe("mapGranularToDbTimeframe", () => {
  it("maps known granular labels, throws on unknown", () => {
    expect(mapGranularToDbTimeframe("15m")).toBe("flash");
    expect(mapGranularToDbTimeframe("1h")).toBe("intraday");
    expect(mapGranularToDbTimeframe("1d")).toBe("daily");
    expect(() => mapGranularToDbTimeframe("7y")).toThrow(/Unsupported/);
  });
});

describe("calculateEndTime", () => {
  const start = new Date("2026-06-23T00:00:00.000Z");

  it("adds the clamped duration to the start time", () => {
    const cfg = TIMEFRAME_CONFIGS.daily;
    const end = calculateEndTime(start, "daily", 1.0);
    const deltaMin = (end.getTime() - start.getTime()) / 60000;
    expect(deltaMin).toBeGreaterThanOrEqual(cfg.minDurationMinutes);
    expect(deltaMin).toBeLessThanOrEqual(cfg.maxDurationMinutes);
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });

  it("clamps a zero modifier up to the minimum duration", () => {
    const cfg = TIMEFRAME_CONFIGS.daily;
    const end = calculateEndTime(start, "daily", 0);
    expect((end.getTime() - start.getTime()) / 60000).toBe(cfg.minDurationMinutes);
  });
});

describe("validateDuration", () => {
  it("accepts in-range, rejects below min", () => {
    const cfg = TIMEFRAME_CONFIGS.daily;
    expect(validateDuration(cfg.minDurationMinutes, "daily").valid).toBe(true);
    expect(validateDuration(cfg.minDurationMinutes - 1, "daily").valid).toBe(false);
  });
});
