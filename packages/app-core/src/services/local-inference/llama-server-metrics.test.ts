import { afterEach, describe, expect, it } from "vitest";
import {
  diffSnapshots,
  fetchMetricsSnapshot,
  type LlamaServerMetricSnapshot,
  parsePrometheusMetrics,
} from "./llama-server-metrics";

describe("parsePrometheusMetrics", () => {
  it("extracts the canonical llama-server counters", () => {
    const body = `
# HELP llamacpp:prompt_tokens_total Number of prompt tokens processed.
# TYPE llamacpp:prompt_tokens_total counter
llamacpp:prompt_tokens_total 1000

# HELP llamacpp:n_tokens_predicted_total Number of generated tokens.
# TYPE llamacpp:n_tokens_predicted_total counter
llamacpp:n_tokens_predicted_total 250

llamacpp:n_prompt_tokens_processed_total 600
llamacpp:n_drafted_total 80
llamacpp:n_drafted_accepted_total 64
llamacpp:kv_cache_tokens 1024
llamacpp:kv_cache_used_cells 4
`;
    const snapshot = parsePrometheusMetrics(body, 1_000);
    expect(snapshot.takenAtMs).toBe(1_000);
    expect(snapshot.scrapeOk).toBe(true);
    expect(snapshot.hasGenerationCounters).toBe(true);
    expect(snapshot.promptTokensTotal).toBe(1000);
    expect(snapshot.predictedTokensTotal).toBe(250);
    expect(snapshot.promptTokensProcessedTotal).toBe(600);
    expect(snapshot.draftedTotal).toBe(80);
    expect(snapshot.acceptedTotal).toBe(64);
    expect(snapshot.kvCacheTokens).toBe(1024);
    expect(snapshot.kvCacheUsedCells).toBe(4);
  });

  it("ignores commentary, blank lines, and unknown counters", () => {
    const body = `
# this is a comment
llamacpp:unknown_counter 999
llamacpp:prompt_tokens_total 10
not_even_a_metric =
`;
    const snapshot = parsePrometheusMetrics(body);
    expect(snapshot.promptTokensTotal).toBe(10);
    // Unknown counters should not bleed into known fields
    expect(snapshot.predictedTokensTotal).toBe(0);
  });

  it("sums labelled DFlash accepted counters and accepts legacy aliases", () => {
    const body = `
llamacpp:n_drafted 80
llamacpp:n_drafted_accepted_total{slot_id="0"} 30
llamacpp:n_drafted_accepted_total{slot_id="1"} 34
`;
    const snapshot = parsePrometheusMetrics(body);
    expect(snapshot.draftedTotal).toBe(80);
    expect(snapshot.acceptedTotal).toBe(64);
  });

  it("prefers an unlabelled DFlash total over labelled shard samples", () => {
    const body = `
llamacpp:n_drafted_accepted_total{slot_id="0"} 30
llamacpp:n_drafted_accepted_total{slot_id="1"} 34
llamacpp:n_drafted_accepted_total 70
`;
    const snapshot = parsePrometheusMetrics(body);
    expect(snapshot.acceptedTotal).toBe(70);
  });

  it("accepts older accepted-token aliases", () => {
    expect(
      parsePrometheusMetrics("llamacpp:n_accepted_total 12").acceptedTotal,
    ).toBe(12);
    expect(parsePrometheusMetrics("llamacpp:n_accepted 13").acceptedTotal).toBe(
      13,
    );
  });

  it("returns zero counters for an empty body", () => {
    const snapshot = parsePrometheusMetrics("");
    expect(snapshot.scrapeOk).toBe(true);
    expect(snapshot.hasGenerationCounters).toBe(false);
    expect(snapshot.promptTokensTotal).toBe(0);
    expect(snapshot.predictedTokensTotal).toBe(0);
    expect(snapshot.draftedTotal).toBe(0);
  });
});

describe("fetchMetricsSnapshot", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("marks scrape failures so callers do not treat zero counters as evidence", async () => {
    globalThis.fetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const snapshot = await fetchMetricsSnapshot("http://127.0.0.1:9999");

    expect(snapshot.scrapeOk).toBe(false);
    expect(snapshot.hasGenerationCounters).toBe(false);
    expect(snapshot.draftedTotal).toBe(0);
  });
});

describe("diffSnapshots cache hit / miss accounting", () => {
  function snap(
    overrides: Partial<LlamaServerMetricSnapshot>,
  ): LlamaServerMetricSnapshot {
    return {
      takenAtMs: 0,
      promptTokensTotal: 0,
      predictedTokensTotal: 0,
      promptTokensProcessedTotal: 0,
      draftedTotal: 0,
      acceptedTotal: 0,
      kvCacheTokens: 0,
      kvCacheUsedCells: 0,
      ...overrides,
    };
  }

  it("treats fresh-prefill tokens as cache_creation_input_tokens", () => {
    const before = snap({});
    // 1000 input tokens, all freshly prefilled (cold call)
    const after = snap({
      promptTokensTotal: 1000,
      predictedTokensTotal: 100,
      promptTokensProcessedTotal: 1000,
    });
    const usage = diffSnapshots(before, after);
    expect(usage.input_tokens).toBe(1000);
    expect(usage.output_tokens).toBe(100);
    expect(usage.cache_creation_input_tokens).toBe(1000);
    expect(usage.cache_read_input_tokens).toBe(0);
    expect(usage.cache_hit_rate).toBe(0);
  });

  it("treats prefix-reuse tokens as cache_read_input_tokens", () => {
    const before = snap({
      promptTokensTotal: 1000,
      predictedTokensTotal: 100,
      promptTokensProcessedTotal: 1000,
    });
    // Second turn: 1100 input total, only 100 new (the user message), prefix reused
    const after = snap({
      promptTokensTotal: 2100,
      predictedTokensTotal: 200,
      promptTokensProcessedTotal: 1100,
    });
    const usage = diffSnapshots(before, after);
    expect(usage.input_tokens).toBe(1100);
    expect(usage.output_tokens).toBe(100);
    expect(usage.cache_creation_input_tokens).toBe(100);
    expect(usage.cache_read_input_tokens).toBe(1000);
    expect(usage.cache_hit_rate).toBeCloseTo(1000 / 1100, 5);
  });

  it("emits dflash_* fields when speculative decoding ran", () => {
    const before = snap({});
    const after = snap({
      promptTokensTotal: 100,
      predictedTokensTotal: 50,
      promptTokensProcessedTotal: 100,
      draftedTotal: 80,
      acceptedTotal: 64,
    });
    const usage = diffSnapshots(before, after);
    expect(usage.dflash_drafted_tokens).toBe(80);
    expect(usage.dflash_accepted_tokens).toBe(64);
    expect(usage.dflash_acceptance_rate).toBe(64 / 80);
  });

  it("omits dflash_* fields when no drafter activity", () => {
    const before = snap({});
    const after = snap({
      promptTokensTotal: 100,
      predictedTokensTotal: 50,
      promptTokensProcessedTotal: 100,
    });
    const usage = diffSnapshots(before, after);
    expect(usage.dflash_drafted_tokens).toBeUndefined();
    expect(usage.dflash_acceptance_rate).toBeUndefined();
  });

  it("clamps negative deltas to zero (counter reset between snapshots)", () => {
    const before = snap({
      promptTokensTotal: 5_000,
      predictedTokensTotal: 1_000,
      promptTokensProcessedTotal: 5_000,
    });
    // Server restart between snapshots drops the counters back to small values
    const after = snap({
      promptTokensTotal: 100,
      predictedTokensTotal: 20,
      promptTokensProcessedTotal: 100,
    });
    const usage = diffSnapshots(before, after);
    // We won't surface negative numbers — clamp to zero, lose the sample
    expect(usage.input_tokens).toBe(0);
    expect(usage.output_tokens).toBe(0);
    expect(usage.cache_creation_input_tokens).toBe(0);
    expect(usage.cache_read_input_tokens).toBe(0);
  });

  it("prefers responseUsage over metric delta when provided", () => {
    const before = snap({});
    // Metric delta says 1000 input tokens, but the response says 800.
    // Trust the response — it's per-call exact.
    const after = snap({
      promptTokensTotal: 1000,
      predictedTokensTotal: 100,
      promptTokensProcessedTotal: 800,
    });
    const usage = diffSnapshots(before, after, {
      prompt_tokens: 800,
      completion_tokens: 100,
    });
    expect(usage.input_tokens).toBe(800);
    expect(usage.output_tokens).toBe(100);
    // 800 fresh-prefilled, 0 reused
    expect(usage.cache_creation_input_tokens).toBe(800);
    expect(usage.cache_read_input_tokens).toBe(0);
  });

  it("hit-rate of 95%+ on 50-turn agentic loop simulation", () => {
    // 50-turn loop: 4000-token system prompt + tool defs reused every turn,
    // plus ~100 token user message + ~100 token assistant message per turn.
    const SYSTEM_TOKENS = 4000;
    const PER_TURN_TOKENS = 200;
    let promptTotal = 0;
    let processedTotal = 0;
    let predictedTotal = 0;
    let totalInputTokens = 0;
    let totalCacheRead = 0;

    let before = snap({});
    for (let turn = 1; turn <= 50; turn += 1) {
      // Each turn carries the entire history. Cache hit = SYSTEM + (turn-1)*PER_TURN.
      const conversationTokens = SYSTEM_TOKENS + (turn - 1) * PER_TURN_TOKENS;
      promptTotal += conversationTokens;
      // Only the new turn's tokens get freshly prefilled — assume the whole
      // history is in cache from the previous turn (perfect prefix reuse).
      const freshTokens = turn === 1 ? SYSTEM_TOKENS : PER_TURN_TOKENS;
      processedTotal += freshTokens;
      predictedTotal += 100;

      const after = snap({
        promptTokensTotal: promptTotal,
        predictedTokensTotal: predictedTotal,
        promptTokensProcessedTotal: processedTotal,
      });
      const usage = diffSnapshots(before, after);
      totalInputTokens += usage.input_tokens;
      totalCacheRead += usage.cache_read_input_tokens;
      before = after;
    }
    const hitRate = totalCacheRead / totalInputTokens;
    expect(hitRate).toBeGreaterThanOrEqual(0.95);
  });
});
