// Exercises recall-bench benchmark recall bench metrics.test behavior against deterministic harness fixtures.
import { describe, expect, it } from "vitest";
import {
  dcgAtK,
  hitRateAtK,
  idealDcgAtK,
  mean,
  ndcgAtK,
  percentile,
  precisionAtK,
  type QueryResult,
  recallAtK,
  reciprocalRank,
  summarizeRecall,
} from "./metrics";

// retrieved [d1, d2, d3, d4]; relevant {d2, d4, d9}. Hand-computed throughout.
const R: QueryResult = {
  retrieved: ["d1", "d2", "d3", "d4"],
  relevant: new Set(["d2", "d4", "d9"]),
};

describe("precisionAtK", () => {
  it("divides hits by the fixed K", () => {
    expect(precisionAtK(R, 1)).toBe(0); // [d1] — no hit
    expect(precisionAtK(R, 2)).toBe(0.5); // [d1,d2] — 1/2
    expect(precisionAtK(R, 4)).toBe(0.5); // {d2,d4} — 2/4
  });
  it("counts unfilled slots as non-relevant (K beyond list length)", () => {
    expect(precisionAtK(R, 8)).toBe(2 / 8); // 2 hits, denominator stays K
  });
  it("is 0 for non-positive K", () => {
    expect(precisionAtK(R, 0)).toBe(0);
  });
});

describe("recallAtK", () => {
  it("divides hits by |relevant|", () => {
    expect(recallAtK(R, 2)).toBeCloseTo(1 / 3, 10); // d2 of {d2,d4,d9}
    expect(recallAtK(R, 4)).toBeCloseTo(2 / 3, 10); // d2,d4
  });
  it("is 0 when nothing is relevant", () => {
    expect(recallAtK({ retrieved: ["a"], relevant: new Set() }, 5)).toBe(0);
  });
});

describe("hitRateAtK", () => {
  it("is 1 iff a relevant doc is in the top-k", () => {
    expect(hitRateAtK(R, 1)).toBe(0);
    expect(hitRateAtK(R, 2)).toBe(1);
  });
});

describe("reciprocalRank", () => {
  it("is 1 / (rank of first relevant)", () => {
    expect(reciprocalRank(R)).toBe(1 / 2); // d2 at rank 2
    expect(
      reciprocalRank({ retrieved: ["d2", "x"], relevant: new Set(["d2"]) }),
    ).toBe(1); // rank 1
  });
  it("is 0 when no relevant doc is retrieved", () => {
    expect(
      reciprocalRank({ retrieved: ["x", "y"], relevant: new Set(["z"]) }),
    ).toBe(0);
  });
});

describe("nDCG@k", () => {
  it("computes DCG with a log2(rank+1) discount", () => {
    // d2 at i=1 → 1/log2(3); d4 at i=3 → 1/log2(5).
    const expected = 1 / Math.log2(3) + 1 / Math.log2(5);
    expect(dcgAtK(R, 4)).toBeCloseTo(expected, 10);
  });
  it("ideal DCG packs relevant docs into the top slots (capped at k)", () => {
    // min(|relevant|=3, k=4)=3 → 1/log2(2)+1/log2(3)+1/log2(4).
    const expected = 1 / Math.log2(2) + 1 / Math.log2(3) + 1 / Math.log2(4);
    expect(idealDcgAtK(R, 4)).toBeCloseTo(expected, 10);
  });
  it("normalizes DCG by the ideal", () => {
    expect(ndcgAtK(R, 4)).toBeCloseTo(dcgAtK(R, 4) / idealDcgAtK(R, 4), 10);
    // A perfectly-ranked result scores 1.0.
    const perfect: QueryResult = {
      retrieved: ["a", "b", "c"],
      relevant: new Set(["a", "b"]),
    };
    expect(ndcgAtK(perfect, 3)).toBeCloseTo(1, 10);
  });
  it("is 0 when there is no ideal gain", () => {
    expect(ndcgAtK({ retrieved: ["a"], relevant: new Set() }, 5)).toBe(0);
  });
});

describe("percentile (nearest-rank)", () => {
  const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  it("returns the nearest-rank value", () => {
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 90)).toBe(90);
    expect(percentile(xs, 95)).toBe(100);
    expect(percentile(xs, 100)).toBe(100);
  });
  it("is order-independent (nearest-rank p50 of even n is the lower-middle)", () => {
    // sorted [10,30,50,100]; rank = ceil(0.5*4) = 2 → 30.
    expect(percentile([100, 10, 50, 30], 50)).toBe(30);
  });
  it("returns null for an empty sample (never 0 — memperf honesty contract)", () => {
    expect(percentile([], 95)).toBeNull();
  });
});

describe("mean", () => {
  it("averages, or null when empty", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBeNull();
  });
});

describe("summarizeRecall", () => {
  it("aggregates per-query metrics and latency percentiles", () => {
    const s = summarizeRecall([R], 4, [12, 30, 9, 100]);
    expect(s.queries).toBe(1);
    expect(s.k).toBe(4);
    expect(s.precisionAtK).toBe(0.5);
    expect(s.recallAtK).toBeCloseTo(2 / 3, 10);
    expect(s.mrr).toBe(0.5);
    expect(s.ndcgAtK).toBeCloseTo(dcgAtK(R, 4) / idealDcgAtK(R, 4), 10);
    expect(s.hitRateAtK).toBe(1);
    // sorted [9,12,30,100]; nearest-rank p50 = ceil(0.5*4)=2 → 12, p95 → 100.
    expect(s.p50LatencyMs).toBe(12);
    expect(s.p95LatencyMs).toBe(100);
    expect(s.measured).toBe(true);
  });
  it("marks an empty run unmeasured with null metrics (no fake zeros)", () => {
    const s = summarizeRecall([], 5);
    expect(s.measured).toBe(false);
    expect(s.precisionAtK).toBeNull();
    expect(s.recallAtK).toBeNull();
    expect(s.p95LatencyMs).toBeNull();
  });
  it("scores a fail-open keyword regression strictly below the vector path", () => {
    // The #9956 silent-degradation risk: vector recall retrieves the relevant
    // doc high; keyword fallback misses it. The metric must reflect the drop.
    const q = new Set(["target"]);
    const vector = summarizeRecall(
      [{ retrieved: ["target", "x", "y"], relevant: q }],
      3,
    );
    const keywordFallback = summarizeRecall(
      [{ retrieved: ["x", "y", "z"], relevant: q }],
      3,
    );
    expect(vector.recallAtK).toBe(1);
    expect(keywordFallback.recallAtK).toBe(0);
    expect((keywordFallback.ndcgAtK ?? 0) < (vector.ndcgAtK ?? 0)).toBe(true);
  });
});
