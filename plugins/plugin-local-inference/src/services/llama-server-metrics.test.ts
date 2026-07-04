/** Unit tests for parsing llama-server Prometheus metrics and diffing snapshots. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	diffSnapshots,
	type LlamaServerMetricSnapshot,
	parsePrometheusMetrics,
} from "./llama-server-metrics";

/**
 * llama-server `/metrics` → Anthropic-shape usage accounting (#8848).
 *
 * `parsePrometheusMetrics` turns the Prometheus exposition payload into a
 * counter snapshot, and `diffSnapshots` differences two snapshots into the
 * cache-aware usage block callers bill against. Both are pure; a regression in
 * the label-summing, the generation-counter flag, the negative-delta clamp, or
 * the cache-creation bound silently corrupts every local-inference usage
 * report. These pin that math.
 */

const snap = (
	o: Partial<LlamaServerMetricSnapshot>,
): LlamaServerMetricSnapshot => ({
	takenAtMs: 0,
	promptTokensTotal: 0,
	predictedTokensTotal: 0,
	promptTokensProcessedTotal: 0,
	draftedTotal: 0,
	acceptedTotal: 0,
	kvCacheTokens: 0,
	kvCacheUsedCells: 0,
	...o,
});

describe("parsePrometheusMetrics", () => {
	it("parses an unlabelled counter and flags generation counters", () => {
		const out = parsePrometheusMetrics(
			"llamacpp:prompt_tokens_total 1234",
			1000,
		);
		expect(out.promptTokensTotal).toBe(1234);
		expect(out.scrapeOk).toBe(true);
		expect(out.hasGenerationCounters).toBe(true);
		expect(out.takenAtMs).toBe(1000);
	});

	it("sums per-slot labelled samples for the same canonical field", () => {
		const body =
			'llamacpp:n_drafted_accepted_total{slot_id="0"} 12\n' +
			'llamacpp:n_drafted_accepted_total{slot_id="1"} 8';
		expect(parsePrometheusMetrics(body, 0).acceptedTotal).toBe(20);
	});

	it("prefers an unlabelled total over the labelled sum of the same field", () => {
		const body =
			'llamacpp:n_drafted_accepted_total{slot_id="0"} 99\n' +
			"llamacpp:n_drafted_accepted_total 5";
		expect(parsePrometheusMetrics(body, 0).acceptedTotal).toBe(5);
	});

	it("skips comments, malformed lines, and unknown counters", () => {
		const body = [
			"# HELP llamacpp:prompt_tokens_total total",
			"# TYPE llamacpp:prompt_tokens_total counter",
			"garbage line here",
			"llamacpp:unknown_counter 7",
		].join("\n");
		const out = parsePrometheusMetrics(body, 0);
		expect(out.promptTokensTotal).toBe(0);
		expect(out.hasGenerationCounters).toBe(false);
		expect(out.scrapeOk).toBe(true);
	});

	it("does not flag generation counters for a gauge-only scrape", () => {
		const out = parsePrometheusMetrics("llamacpp:kv_cache_tokens 512", 0);
		expect(out.kvCacheTokens).toBe(512);
		expect(out.hasGenerationCounters).toBe(false);
	});

	it("returns an all-zero snapshot for an empty body", () => {
		const out = parsePrometheusMetrics("", 0);
		expect(out).toMatchObject({
			promptTokensTotal: 0,
			predictedTokensTotal: 0,
			acceptedTotal: 0,
			hasGenerationCounters: false,
			scrapeOk: true,
		});
	});
});

describe("diffSnapshots", () => {
	it("computes input/output and the cache creation/read split", () => {
		const block = diffSnapshots(
			snap({
				promptTokensTotal: 100,
				predictedTokensTotal: 10,
				promptTokensProcessedTotal: 40,
			}),
			snap({
				promptTokensTotal: 200,
				predictedTokensTotal: 30,
				promptTokensProcessedTotal: 90,
			}),
		);
		expect(block).toMatchObject({
			input_tokens: 100,
			output_tokens: 20,
			cache_creation_input_tokens: 50, // 90-40 processed
			cache_read_input_tokens: 50, // 100 input - 50 fresh
			cache_hit_rate: 0.5,
		});
	});

	it("clamps negative deltas (server restart) to zero and omits cache_hit_rate", () => {
		const block = diffSnapshots(
			snap({ promptTokensTotal: 200, predictedTokensTotal: 50 }),
			snap({ promptTokensTotal: 100, predictedTokensTotal: 10 }),
		);
		expect(block.input_tokens).toBe(0);
		expect(block.output_tokens).toBe(0);
		expect(block.cache_hit_rate).toBeUndefined();
	});

	it("lets responseUsage override the metric delta", () => {
		const block = diffSnapshots(
			snap({}),
			snap({ promptTokensTotal: 1000, predictedTokensTotal: 500 }),
			{ prompt_tokens: 7, completion_tokens: 3 },
		);
		expect(block.input_tokens).toBe(7);
		expect(block.output_tokens).toBe(3);
		expect(block.cache_read_input_tokens).toBe(7); // no fresh prefill → all cached
		expect(block.cache_hit_rate).toBe(1);
	});

	it("bounds cache creation by the per-call input count", () => {
		const block = diffSnapshots(
			snap({}),
			snap({ promptTokensTotal: 100, promptTokensProcessedTotal: 300 }),
		);
		expect(block.cache_creation_input_tokens).toBe(100); // min(300, 100)
		expect(block.cache_read_input_tokens).toBe(0);
		expect(block.cache_hit_rate).toBe(0);
	});

	it("adds MTP fields only when speculative tokens were drafted", () => {
		const withMtp = diffSnapshots(
			snap({}),
			snap({
				promptTokensTotal: 50,
				predictedTokensTotal: 50,
				draftedTotal: 10,
				acceptedTotal: 6,
			}),
		);
		expect(withMtp).toMatchObject({
			mtp_drafted_tokens: 10,
			mtp_accepted_tokens: 6,
			mtp_acceptance_rate: 0.6,
		});

		const noMtp = diffSnapshots(
			snap({}),
			snap({ promptTokensTotal: 10, predictedTokensTotal: 10 }),
		);
		expect(noMtp.mtp_drafted_tokens).toBeUndefined();
		expect(noMtp.mtp_acceptance_rate).toBeUndefined();
	});
});
