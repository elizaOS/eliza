/**
 * Unit coverage for view memory-growth reporting from heap samples. Pure
 * functions, no runtime.
 */
import { describe, expect, it } from "vitest";
import {
  shouldReportMemoryGrowth,
  summarizeMemorySamples,
} from "./view-memory-budget";

const MB = 1024 * 1024;

describe("summarizeMemorySamples", () => {
  it("returns a zeroed summary for no samples", () => {
    const s = summarizeMemorySamples([]);
    expect(s.sampleCount).toBe(0);
    expect(s.growthRatio).toBe(1);
    expect(s.slopeBytesPerCycle).toBe(0);
  });

  it("computes a flat trend for a stable (sawtooth) heap", () => {
    // GC sawtooth around 50MiB — no net growth.
    const samples = [50, 52, 49, 51, 50, 52, 49, 51, 50, 52].map((m) => m * MB);
    const s = summarizeMemorySamples(samples);
    expect(Math.abs(s.slopeBytesPerCycle)).toBeLessThan(0.5 * MB);
    expect(s.growthRatio).toBeCloseTo(1, 1);
    expect(s.monotonicIncreaseRatio).toBeLessThan(0.7);
  });

  it("computes a steep positive slope for a leaking heap", () => {
    // +2MiB every cycle — a clear staircase leak.
    const samples = Array.from({ length: 10 }, (_, i) => (40 + i * 2) * MB);
    const s = summarizeMemorySamples(samples);
    expect(s.slopeBytesPerCycle).toBeGreaterThan(1.5 * MB);
    expect(s.monotonicIncreaseRatio).toBe(1);
    expect(s.netGrowthBytes).toBe(18 * MB);
  });
});

describe("shouldReportMemoryGrowth", () => {
  it("does NOT flag a stable sawtooth", () => {
    const samples = [50, 53, 48, 51, 50, 52, 49, 51, 50, 53].map((m) => m * MB);
    const report = shouldReportMemoryGrowth(summarizeMemorySamples(samples));
    expect(report.leaking).toBe(false);
    expect(report.reasons).toEqual([]);
  });

  it("FLAGS a monotonic staircase leak", () => {
    const samples = Array.from({ length: 12 }, (_, i) => (40 + i * 2) * MB);
    const report = shouldReportMemoryGrowth(summarizeMemorySamples(samples));
    expect(report.leaking).toBe(true);
    expect(report.reasons.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag a single late GC bump (not monotonic)", () => {
    // Flat then one big jump at the end — high last/first but low monotonicity.
    const samples = [50, 50, 50, 50, 50, 50, 50, 50, 50, 90].map((m) => m * MB);
    const report = shouldReportMemoryGrowth(summarizeMemorySamples(samples));
    expect(report.leaking).toBe(false);
  });

  it("withholds judgement below the min sample count", () => {
    const samples = [40, 60, 80].map((m) => m * MB); // clearly rising but n<5
    const report = shouldReportMemoryGrowth(summarizeMemorySamples(samples));
    expect(report.leaking).toBe(false);
  });

  it("respects a custom slope budget", () => {
    const samples = Array.from({ length: 10 }, (_, i) => (40 + i * 0.6) * MB);
    // 0.6MiB/cycle: over the default 0.5MiB budget AND monotonic → flagged.
    expect(
      shouldReportMemoryGrowth(summarizeMemorySamples(samples)).leaking,
    ).toBe(true);
    // Loosen the budget to 1MiB/cycle → no longer flagged.
    expect(
      shouldReportMemoryGrowth(summarizeMemorySamples(samples), {
        maxSlopeBytesPerCycle: MB,
        maxGrowthRatio: 2,
      }).leaking,
    ).toBe(false);
  });
});
