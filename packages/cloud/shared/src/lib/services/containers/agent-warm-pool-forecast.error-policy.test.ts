/**
 * Error-policy pin for the warm-pool forecast (#13415).
 *
 * This module is container-provisioning infra: its `targetPoolSize` drives how
 * many sandboxes the autoscaler spins up (real cloud cost). Under the
 * fail-closed doctrine an INTERNAL failure (invalid policy config) must
 * PROPAGATE as a thrown typed error rather than be swallowed into a default
 * pool size, while a DESIGNED-EMPTY input (an actually-empty forecast window)
 * must stay distinguishable: it yields a rate of 0 and clamps to the floor,
 * never throws. These tests pin that the two paths never collapse into each
 * other — the file has no catch/`?? default` slop to remove, so this pins the
 * already-fail-closed behavior against regression.
 */

import { beforeEach, describe, expect, it } from "bun:test";

let mod: typeof import("./agent-warm-pool-forecast");

beforeEach(async () => {
  mod = await import("./agent-warm-pool-forecast");
});

const base = {
  bucketCounts: [] as number[],
  emaAlpha: 0.5,
  leadTimeBuckets: 1,
  minPoolSize: 1,
  maxPoolSize: 10,
};

describe("agent-warm-pool-forecast — internal failure propagates (fail closed)", () => {
  it("throws instead of returning a default pool size when min > max", () => {
    // A broken policy is an internal invariant violation, not a quiet clamp:
    // it must surface so the autoscaler never provisions against garbage.
    expect(() => mod.computeForecast({ ...base, minPoolSize: 5, maxPoolSize: 4 })).toThrow(
      /minPoolSize cannot exceed maxPoolSize/,
    );
  });

  it("throws on an out-of-range smoothing factor rather than silently coercing", () => {
    for (const emaAlpha of [0, -0.1, 1.5]) {
      expect(() => mod.computeForecast({ ...base, emaAlpha, bucketCounts: [3] })).toThrow(
        /emaAlpha/,
      );
    }
  });

  it("throws on a negative lead time rather than fabricating a target", () => {
    expect(() => mod.computeForecast({ ...base, leadTimeBuckets: -1 })).toThrow(
      /leadTimeBuckets must be non-negative/,
    );
  });
});

describe("agent-warm-pool-forecast — designed-empty stays distinct from failure", () => {
  it("an empty forecast window returns rate 0 clamped to the floor, without throwing", () => {
    // 200-with-no-provisions is a legitimate empty result, NOT an infra failure:
    // it must produce a concrete forecast (rate 0, target = minPoolSize), never
    // the throw path above.
    const out = mod.computeForecast({ ...base, minPoolSize: 2, bucketCounts: [] });
    expect(out.predictedRate).toBe(0);
    expect(out.observedBuckets).toBe(0);
    expect(out.targetPoolSize).toBe(2);
  });

  it("a real non-empty window yields a positive rate distinct from the empty case", () => {
    const empty = mod.computeForecast({ ...base, bucketCounts: [] });
    const busy = mod.computeForecast({ ...base, emaAlpha: 1, bucketCounts: [10, 10, 10] });
    expect(empty.predictedRate).toBe(0);
    expect(busy.predictedRate).toBeGreaterThan(0);
    // Demand pushes the target above the floor — the two inputs are not conflated.
    expect(busy.targetPoolSize).toBeGreaterThan(empty.targetPoolSize);
  });
});
