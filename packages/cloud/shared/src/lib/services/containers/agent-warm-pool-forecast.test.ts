/**
 * Characterization tests for the warm-pool demand forecast.
 *
 * `agent-warm-pool-forecast.ts` advertises itself as "Pure functions" and the
 * warm-pool manager docstring claims the decision layer is "tested in
 * isolation" — but there was no test for `computeForecast` before this. These
 * pin the invariants that decide the agent warm-pool's target size (the input
 * to every replenish/drain decision), so the autoscaler tuning in #8348/#8353/
 * #8357 can't silently change them.
 */

import { describe, expect, test } from "bun:test";
import {
  computeForecast,
  DEFAULT_WARM_POOL_POLICY,
  type ForecastInput,
} from "./agent-warm-pool-forecast";

const base: ForecastInput = {
  bucketCounts: [],
  emaAlpha: 0.5,
  leadTimeBuckets: 1,
  minPoolSize: 1,
  maxPoolSize: 10,
};

describe("computeForecast — guards", () => {
  test("throws when minPoolSize exceeds maxPoolSize", () => {
    expect(() => computeForecast({ ...base, minPoolSize: 5, maxPoolSize: 4 })).toThrow(
      /minPoolSize cannot exceed maxPoolSize/,
    );
  });

  test("throws when emaAlpha is out of (0, 1]", () => {
    expect(() => computeForecast({ ...base, emaAlpha: 0 })).toThrow(/emaAlpha/);
    expect(() => computeForecast({ ...base, emaAlpha: -0.1 })).toThrow(/emaAlpha/);
    expect(() => computeForecast({ ...base, emaAlpha: 1.5 })).toThrow(/emaAlpha/);
  });

  test("accepts the boundary emaAlpha = 1", () => {
    expect(() => computeForecast({ ...base, emaAlpha: 1, bucketCounts: [3] })).not.toThrow();
  });

  test("throws when leadTimeBuckets is negative", () => {
    expect(() => computeForecast({ ...base, leadTimeBuckets: -1 })).toThrow(
      /leadTimeBuckets must be non-negative/,
    );
  });
});

describe("computeForecast — empty window", () => {
  test("no buckets ⇒ rate 0, target floored at minPoolSize, observedBuckets 0", () => {
    const out = computeForecast({ ...base, minPoolSize: 2, bucketCounts: [] });
    expect(out.predictedRate).toBe(0);
    expect(out.targetPoolSize).toBe(2);
    expect(out.observedBuckets).toBe(0);
  });
});

describe("computeForecast — EMA", () => {
  test("a single bucket is honored (EMA seeded at the first observation)", () => {
    // Seed = bucketCounts[0]; with one bucket the EMA stays at that value.
    const out = computeForecast({ ...base, emaAlpha: 0.5, bucketCounts: [4] });
    expect(out.predictedRate).toBe(4);
    expect(out.observedBuckets).toBe(1);
  });

  test("alpha = 1 makes the forecast equal the most recent bucket", () => {
    const out = computeForecast({ ...base, emaAlpha: 1, bucketCounts: [10, 0, 7] });
    expect(out.predictedRate).toBe(7);
  });

  test("a steady rate forecasts to that rate", () => {
    const out = computeForecast({ ...base, emaAlpha: 0.5, bucketCounts: [3, 3, 3, 3] });
    expect(out.predictedRate).toBeCloseTo(3, 10);
  });

  test("recent buckets dominate older ones under EMA", () => {
    const rising = computeForecast({ ...base, emaAlpha: 0.5, bucketCounts: [0, 0, 8] });
    const falling = computeForecast({ ...base, emaAlpha: 0.5, bucketCounts: [8, 0, 0] });
    expect(rising.predictedRate).toBeGreaterThan(falling.predictedRate);
  });
});

describe("computeForecast — target sizing + clamp", () => {
  test("target = ceil(rate × leadTime) + minPoolSize, then clamped", () => {
    // rate 3 (steady), lead 1, floor 1 ⇒ ceil(3) + 1 = 4.
    const out = computeForecast({
      ...base,
      minPoolSize: 1,
      maxPoolSize: 10,
      leadTimeBuckets: 1,
      bucketCounts: [3, 3, 3],
    });
    expect(out.predictedRate).toBeCloseTo(3, 10);
    expect(out.targetPoolSize).toBe(4);
  });

  test("a low non-zero rate still lifts target above the floor (ceil rounds up)", () => {
    // rate 1, lead 0.025 ⇒ ceil(0.025) = 1, + floor 1 = 2.
    const out = computeForecast({
      ...base,
      minPoolSize: 1,
      maxPoolSize: 10,
      leadTimeBuckets: 0.025,
      bucketCounts: [1],
    });
    expect(out.targetPoolSize).toBe(2);
  });

  test("clamps up to maxPoolSize on a burst", () => {
    const out = computeForecast({
      ...base,
      minPoolSize: 1,
      maxPoolSize: 5,
      leadTimeBuckets: 1,
      bucketCounts: [100, 100, 100],
    });
    expect(out.targetPoolSize).toBe(5);
  });

  test("a zero rate keeps target exactly at the floor", () => {
    const out = computeForecast({
      ...base,
      minPoolSize: 3,
      maxPoolSize: 10,
      bucketCounts: [0, 0, 0],
    });
    expect(out.predictedRate).toBe(0);
    expect(out.targetPoolSize).toBe(3);
  });

  test("leadTimeBuckets = 0 pins target to the floor regardless of rate", () => {
    const out = computeForecast({
      ...base,
      minPoolSize: 1,
      maxPoolSize: 10,
      leadTimeBuckets: 0,
      bucketCounts: [50, 50],
    });
    expect(out.targetPoolSize).toBe(1);
  });
});

describe("DEFAULT_WARM_POOL_POLICY", () => {
  test("is internally consistent (floor ≤ ceiling, valid alpha, sane windows)", () => {
    const p = DEFAULT_WARM_POOL_POLICY;
    expect(p.minPoolSize).toBeLessThanOrEqual(p.maxPoolSize);
    expect(p.emaAlpha).toBeGreaterThan(0);
    expect(p.emaAlpha).toBeLessThanOrEqual(1);
    expect(p.leadTimeBuckets).toBeGreaterThanOrEqual(0);
    expect(p.replenishBurstLimit).toBeGreaterThan(0);
    // The default policy must be a usable forecast input.
    expect(() =>
      computeForecast({
        bucketCounts: [1, 2, 3],
        emaAlpha: p.emaAlpha,
        leadTimeBuckets: p.leadTimeBuckets,
        minPoolSize: p.minPoolSize,
        maxPoolSize: p.maxPoolSize,
      }),
    ).not.toThrow();
  });
});
