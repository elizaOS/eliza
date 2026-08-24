/**
 * Verifies the deterministic microbenchmark helper through its real runtime
 * behaviour: warmup/measured call accounting, the exact median and p95
 * selection over numerically sorted samples, and exception propagation.
 * Statistics are pinned exactly with a scripted `performance.now` clock
 * (same idiom as event-clock.test.ts); one case sanity-checks an unmocked
 * wall-clock run so the helper stays honest against the real timer.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { benchmark } from "./microbench";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Installs a `performance.now` spy whose paired readings yield `durations`. */
function scriptedClock(durationsMs: number[]): void {
  const ticks: number[] = [];
  let elapsed = 0;
  for (const duration of durationsMs) {
    ticks.push(elapsed);
    elapsed += duration;
    ticks.push(elapsed);
  }
  const pending = [...ticks];
  vi.spyOn(performance, "now").mockImplementation(() => pending.shift() ?? 0);
}

describe("benchmark call accounting", () => {
  it("defaults to 200 measured iterations after 20 discarded warmup calls", () => {
    let calls = 0;
    const result = benchmark(() => {
      calls += 1;
    });
    expect(result.samples).toBe(200);
    expect(calls).toBe(220);
  });

  it("honours explicit iteration and warmup options", () => {
    let calls = 0;
    const result = benchmark(
      () => {
        calls += 1;
      },
      { iterations: 50, warmup: 5 },
    );
    expect(result.samples).toBe(50);
    expect(calls).toBe(55);
  });

  it("runs every warmup call before the first measured call", () => {
    const log: string[] = [];
    vi.spyOn(performance, "now").mockImplementation(() => {
      log.push("clock");
      return 0;
    });
    benchmark(
      () => {
        log.push("fn");
      },
      { iterations: 3, warmup: 2 },
    );
    // Warmup calls never touch the clock; each measured iteration reads it
    // once before invoking fn and once after.
    expect(log.slice(0, 2)).toEqual(["fn", "fn"]);
    expect(log.slice(2)).toEqual([
      "clock",
      "fn",
      "clock",
      "clock",
      "fn",
      "clock",
      "clock",
      "fn",
      "clock",
    ]);
  });
});

describe("benchmark summary statistics", () => {
  it("sorts samples numerically, not lexicographically", () => {
    // Durations [10, 9, 2]: lexicographic ordering ("10" < "2" < "9") would
    // pick 2ms as the median; numeric ordering must pick 9ms.
    scriptedClock([10, 9, 2]);
    const result = benchmark(() => {}, { iterations: 3, warmup: 0 });
    expect(result.medianMs).toBe(9);
    expect(result.p95Ms).toBe(10);
  });

  it("picks the upper middle sample for an even count", () => {
    scriptedClock([4, 1, 3, 2]);
    const result = benchmark(() => {}, { iterations: 4, warmup: 0 });
    expect(result.medianMs).toBe(3);
    expect(result.p95Ms).toBe(4);
  });

  it("reads p95 at floor(0.95 * n) for a forty-sample window", () => {
    // A fixed permutation of 1..40 (7 is coprime to 40) delivered out of
    // order: sorted, the median sits at index 20 (21ms) and p95 at index 38
    // (39ms) — one below the maximum, exercising the clamped p95 index.
    const durations = Array.from({ length: 40 }, (_, i) => ((i * 7) % 40) + 1);
    scriptedClock(durations);
    const result = benchmark(() => {}, { iterations: 40, warmup: 0 });
    expect(result.medianMs).toBe(21);
    expect(result.p95Ms).toBe(39);
  });

  it("reports one identical sample for a single measured call", () => {
    scriptedClock([5]);
    let calls = 0;
    const result = benchmark(
      () => {
        calls += 1;
      },
      { iterations: 1, warmup: 0 },
    );
    expect(calls).toBe(1);
    expect(result.medianMs).toBe(5);
    expect(result.p95Ms).toBe(5);
    expect(result.samples).toBe(1);
  });

  it("returns the three documented statistic fields", () => {
    const result = benchmark(() => {});
    expect(Object.keys(result).sort()).toEqual([
      "medianMs",
      "p95Ms",
      "samples",
    ]);
    expect(typeof result.medianMs).toBe("number");
    expect(typeof result.p95Ms).toBe("number");
    expect(typeof result.samples).toBe("number");
  });
});

describe("benchmark against the real wall clock", () => {
  it("produces finite, ordered, non-negative timings", () => {
    let sum = 0;
    const result = benchmark(() => {
      sum += 1;
    });
    expect(sum).toBe(220);
    expect(Number.isFinite(result.medianMs)).toBe(true);
    expect(Number.isFinite(result.p95Ms)).toBe(true);
    expect(result.medianMs).toBeGreaterThanOrEqual(0);
    expect(result.p95Ms).toBeGreaterThanOrEqual(result.medianMs);
    expect(result.samples).toBe(200);
  });
});

describe("benchmark failure behaviour", () => {
  it("propagates a warmup throw before reading the clock", () => {
    const now = vi.spyOn(performance, "now");
    expect(() =>
      benchmark(() => {
        throw new Error("boom in warmup");
      }),
    ).toThrow("boom in warmup");
    expect(now).not.toHaveBeenCalled();
  });

  it("propagates a throw raised mid-measurement", () => {
    let calls = 0;
    expect(() =>
      benchmark(
        () => {
          calls += 1;
          if (calls > 1) {
            throw new Error("boom mid-measure");
          }
        },
        { iterations: 3, warmup: 1 },
      ),
    ).toThrow("boom mid-measure");
    expect(calls).toBe(2);
  });
});

describe("benchmark degenerate windows", () => {
  it("measures nothing for zero iterations", () => {
    const now = vi.spyOn(performance, "now");
    const result = benchmark(() => {}, { iterations: 0, warmup: 0 });
    expect(result.samples).toBe(0);
    expect(now).not.toHaveBeenCalled();
    expect(result.medianMs).toBeUndefined();
    expect(result.p95Ms).toBeUndefined();
  });
});
