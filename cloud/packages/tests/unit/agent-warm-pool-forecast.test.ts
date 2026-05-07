import { describe, expect, test } from "bun:test";
import {
  computeForecast,
  DEFAULT_WARM_POOL_POLICY,
  type ForecastInput,
} from "@/lib/services/containers/agent-warm-pool-forecast";

function input(overrides: Partial<ForecastInput> = {}): ForecastInput {
  return {
    bucketCounts: [],
    emaAlpha: DEFAULT_WARM_POOL_POLICY.emaAlpha,
    leadTimeBuckets: DEFAULT_WARM_POOL_POLICY.leadTimeBuckets,
    minPoolSize: DEFAULT_WARM_POOL_POLICY.minPoolSize,
    maxPoolSize: DEFAULT_WARM_POOL_POLICY.maxPoolSize,
    ...overrides,
  };
}

describe("computeForecast", () => {
  test("zero observations falls to minPoolSize", () => {
    const out = computeForecast(input({ bucketCounts: [] }));
    expect(out.predictedRate).toBe(0);
    expect(out.targetPoolSize).toBe(1);
    expect(out.observedBuckets).toBe(0);
  });

  test("steady low traffic stays at floor", () => {
    const out = computeForecast(input({ bucketCounts: [0, 0, 0, 0, 0, 0] }));
    expect(out.targetPoolSize).toBe(1);
  });

  test("single recent provision raises target above floor", () => {
    const out = computeForecast(input({ bucketCounts: [0, 0, 0, 0, 0, 4] }));
    expect(out.predictedRate).toBeGreaterThan(0);
    expect(out.targetPoolSize).toBeGreaterThan(1);
  });

  test("sustained high rate caps at maxPoolSize", () => {
    const out = computeForecast(input({ bucketCounts: [50, 50, 50, 50, 50, 50] }));
    expect(out.targetPoolSize).toBe(10);
  });

  test("EMA smooths a single quiet hour after sustained traffic", () => {
    const sustained = computeForecast(
      input({ bucketCounts: [10, 10, 10, 10, 10, 10] }),
    );
    const quietBlip = computeForecast(input({ bucketCounts: [10, 10, 10, 10, 10, 0] }));
    // Recovering from one zero bucket should not collapse the recommendation
    // to the floor.
    expect(quietBlip.targetPoolSize).toBeGreaterThan(1);
    expect(quietBlip.targetPoolSize).toBeLessThanOrEqual(sustained.targetPoolSize);
  });

  test("clamps respect min ≤ max contract", () => {
    expect(() =>
      computeForecast(input({ minPoolSize: 5, maxPoolSize: 2 })),
    ).toThrow(/minPoolSize cannot exceed maxPoolSize/);
  });

  test("rejects out-of-range alpha", () => {
    expect(() => computeForecast(input({ emaAlpha: 0 }))).toThrow();
    expect(() => computeForecast(input({ emaAlpha: 1.5 }))).toThrow();
  });

  test("rejects negative lead time", () => {
    expect(() => computeForecast(input({ leadTimeBuckets: -1 }))).toThrow();
  });

  test("alpha=1 gives pure last-bucket reaction", () => {
    const out = computeForecast(
      input({ bucketCounts: [0, 0, 0, 0, 0, 7], emaAlpha: 1, leadTimeBuckets: 1 }),
    );
    expect(out.predictedRate).toBe(7);
    expect(out.targetPoolSize).toBe(8);
  });

  test("non-integer recommendation rounds up — never below true demand", () => {
    // Predicted rate of 2.4 should yield ceil(2.4) + 1 = 4 (not 3).
    const out = computeForecast(
      input({ bucketCounts: [3, 2, 3, 2], emaAlpha: 0.5, leadTimeBuckets: 1 }),
    );
    expect(out.predictedRate).toBeGreaterThan(2);
    expect(out.predictedRate).toBeLessThan(3);
    expect(out.targetPoolSize).toBe(4);
  });

  test("zero leadTimeBuckets collapses to floor", () => {
    const out = computeForecast(
      input({ bucketCounts: [10, 10, 10], leadTimeBuckets: 0 }),
    );
    expect(out.targetPoolSize).toBe(1);
  });

  test("DEFAULT_WARM_POOL_POLICY enforces project ask: min=1 max=10", () => {
    expect(DEFAULT_WARM_POOL_POLICY.minPoolSize).toBe(1);
    expect(DEFAULT_WARM_POOL_POLICY.maxPoolSize).toBe(10);
  });
});
