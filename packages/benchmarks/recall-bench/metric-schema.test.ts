/**
 * Schema-contract tests for the recall-bench metric schema (#9956).
 *
 * Run: bun test packages/benchmarks/recall-bench/metric-schema.test.ts
 *
 * Pins the field set the harness emits and enforces the honesty contract:
 * every numeric field on an unmeasured row is null (never 0). No models, no
 * network: pure schema assertions, CI-safe everywhere (no workspace install
 * needed to run this file).
 */

import { describe, expect, it } from "bun:test";

import {
	K_VALUES,
	METRIC_SCHEMA,
	METRIC_SCHEMA_VERSION,
	SEARCH_MODES,
	skippedRow,
} from "./metric-schema.mjs";

describe("recall-bench metric schema", () => {
	it("pins the search modes the harness scores", () => {
		expect([...SEARCH_MODES]).toEqual([
			"hybrid",
			"vector",
			"keyword",
			"runtime-vector",
			"keyword-chat-search",
		]);
	});

	it("pins the k cut-offs", () => {
		expect([...K_VALUES]).toEqual([1, 3, 5, 10]);
	});

	it("pins the per-row field names and version", () => {
		expect(METRIC_SCHEMA.version).toBe(METRIC_SCHEMA_VERSION);
		expect(METRIC_SCHEMA.modeFields).toEqual([
			"mode",
			"measured",
			"skipReason",
			"numQueries",
			"precisionAtK",
			"recallAtK",
			"mrr",
			"ndcgAtK",
			"hitRateAtK",
			"latencyMsP50",
			"latencyMsP95",
			"recallAt5",
			"ndcgAt10",
		]);
		expect(METRIC_SCHEMA.issue).toBe("#9956");
	});

	it("skippedRow yields a measured:false row with every schema field present", () => {
		const row = skippedRow("hybrid", "no embedding model");
		expect(row.measured).toBe(false);
		expect(row.skipReason).toBe("no embedding model");
		for (const field of METRIC_SCHEMA.modeFields) {
			expect(field in row).toBe(true);
		}
	});

	it("skippedRow numerics are null (not 0 — never conflate not-measured with zero)", () => {
		const row = skippedRow("vector", "skip");
		for (const f of METRIC_SCHEMA.nullableScoreFields) {
			// @ts-expect-error indexed access on the row object
			expect(row[f]).toBeNull();
		}
		for (const f of METRIC_SCHEMA.nullableKMapFields) {
			// @ts-expect-error indexed access on the row object
			const kmap = row[f] as Record<number, number | null>;
			for (const k of K_VALUES) {
				expect(kmap[k]).toBeNull();
			}
		}
	});
});
