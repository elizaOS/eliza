/**
 * Unit tests for the IR metrics (#9956).
 *
 * Run (no workspace install needed): bun test packages/benchmarks/recall-bench/ir-metrics.test.ts
 *
 * These pin the exact semantics ported from
 * `packages/benchmarks/experience/.../evaluators/retrieval.py` plus the binary
 * nDCG. The headline hand-computed fixture is resultIds=["a","b","c"],
 * relevant={"b"}:
 *   P@1 = 0          (top-1 is "a", not relevant)
 *   P@3 = 1/3        (1 hit / k=3)
 *   R@3 = 1          (1 hit / 1 relevant)
 *   MRR = 1/2        ("b" is at rank 2)
 *   Hit@3 = 1        (a relevant id is in top-3)
 *   nDCG@3 = (1/log2(3)) / 1 ≈ 0.6309   (DCG: "b" at position 2 → 1/log2(2+1); IDCG: 1 relevant → 1/log2(1+1)=1)
 */

import { describe, expect, it } from "bun:test";

import {
	evaluateRetrieval,
	hitRateAtK,
	ndcgAtK,
	percentiles,
	precisionAtK,
	type RankedQuery,
	recallAtK,
	reciprocalRank,
} from "./ir-metrics.ts";

const approx = (v: number, expected: number, eps = 1e-9) =>
	expect(Math.abs(v - expected)).toBeLessThan(eps);

describe("recall-bench IR metrics — known-value fixture", () => {
	const resultIds = ["a", "b", "c"];
	const relevant = new Set(["b"]);

	it("precisionAtK divides by k (penalises against k, not #results)", () => {
		approx(precisionAtK(resultIds, relevant, 1), 0);
		approx(precisionAtK(resultIds, relevant, 3), 1 / 3);
		// k larger than #results still divides by k.
		approx(precisionAtK(resultIds, relevant, 10), 1 / 10);
		expect(precisionAtK(resultIds, relevant, 0)).toBe(0);
	});

	it("recallAtK divides by |relevant|, 0 when relevant empty", () => {
		approx(recallAtK(resultIds, relevant, 1), 0);
		approx(recallAtK(resultIds, relevant, 3), 1);
		expect(recallAtK(resultIds, new Set<string>(), 3)).toBe(0);
	});

	it("hitRateAtK is binary per query", () => {
		expect(hitRateAtK(resultIds, relevant, 1)).toBe(0);
		expect(hitRateAtK(resultIds, relevant, 2)).toBe(1);
		expect(hitRateAtK(resultIds, relevant, 3)).toBe(1);
	});

	it("reciprocalRank is the FIRST relevant hit, 1-based", () => {
		approx(reciprocalRank(resultIds, relevant), 1 / 2);
		expect(reciprocalRank(resultIds, new Set(["zzz"]))).toBe(0);
		// First hit wins even if a later one exists.
		approx(reciprocalRank(["x", "y", "a", "b"], new Set(["b", "a"])), 1 / 3);
	});

	it("ndcgAtK is binary DCG/IDCG with IDCG over min(k,|relevant|)", () => {
		approx(ndcgAtK(resultIds, relevant, 3), 1 / Math.log2(3)); // ≈ 0.6309
		// Perfect ranking → 1.
		approx(ndcgAtK(["b", "a", "c"], relevant, 3), 1);
		// No relevant → 0.
		expect(ndcgAtK(resultIds, new Set<string>(), 3)).toBe(0);
	});

	it("ndcg@3 numeric value matches the documented ≈0.6309", () => {
		const v = ndcgAtK(resultIds, relevant, 3);
		expect(v).toBeGreaterThan(0.63);
		expect(v).toBeLessThan(0.631);
	});
});

describe("recall-bench IR metrics — multi-relevant + dedup behaviour", () => {
	it("set-dedup for precision/recall, raw-list for MRR", () => {
		// "b" appears twice; P/R must count it once, MRR uses its first rank (2).
		const resultIds = ["a", "b", "b", "d"];
		const relevant = new Set(["b", "d"]);
		approx(precisionAtK(resultIds, relevant, 4), 2 / 4); // {a,b,d} ∩ {b,d} = 2 hits / k=4
		approx(recallAtK(resultIds, relevant, 4), 1); // 2 of 2 relevant
		approx(reciprocalRank(resultIds, relevant), 1 / 2); // first hit "b" at rank 2
	});

	it("two relevant in ideal positions → IDCG uses both slots", () => {
		// relevant = {a,b}; ranking a,b,c → DCG = 1/log2(2) + 1/log2(3);
		// IDCG (2 relevant) = same → nDCG = 1.
		const v = ndcgAtK(["a", "b", "c"], new Set(["a", "b"]), 3);
		approx(v, 1);
	});
});

describe("recall-bench evaluateRetrieval — macro-average", () => {
	it("averages each metric over the query set", () => {
		const queries: RankedQuery[] = [
			{ resultIds: ["a", "b", "c"], relevantIds: new Set(["b"]) }, // P@3=1/3, R@3=1, MRR=1/2
			{ resultIds: ["x", "y", "z"], relevantIds: new Set(["x"]) }, // P@3=1/3, R@3=1, MRR=1
		];
		const m = evaluateRetrieval(queries, [1, 3]);
		expect(m.numQueries).toBe(2);
		approx(m.precisionAtK[3], 1 / 3); // (1/3 + 1/3)/2
		approx(m.recallAtK[3], 1); // (1 + 1)/2
		approx(m.meanReciprocalRank, (1 / 2 + 1) / 2); // 0.75
		approx(m.precisionAtK[1], (0 + 1) / 2); // q1 top-1 miss, q2 top-1 hit
		approx(m.hitRateAtK[1], (0 + 1) / 2);
	});

	it("empty query set does not divide by zero", () => {
		const m = evaluateRetrieval([], [1, 5]);
		expect(m.numQueries).toBe(0);
		expect(m.meanReciprocalRank).toBe(0);
		expect(m.recallAtK[5]).toBe(0);
	});
});

describe("recall-bench percentiles", () => {
	it("returns null for an empty sample (never 0)", () => {
		expect(percentiles([])).toEqual({ p50: null, p95: null });
	});

	it("nearest-rank p50/p95", () => {
		const s = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
		const { p50, p95 } = percentiles(s);
		expect(p50).toBe(50); // ceil(0.5*10)=5 → 5th = 50
		expect(p95).toBe(100); // ceil(0.95*10)=10 → 10th = 100
	});
});
