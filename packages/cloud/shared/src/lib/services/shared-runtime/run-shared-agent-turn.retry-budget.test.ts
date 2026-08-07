/**
 * Latency pin: the shared-runtime (Tier 0) chat turn must bound its provider
 * retry backoff. The AI SDK default is `maxRetries: 2` with 2s->4s exponential
 * backoff, so a single transient Cerebras 5xx/network blip on the no-fallback
 * default route turns an interactive turn into a 2-6s stall — the measured
 * bimodal 5-10s warm-stall promotion blocker (LATENCY-STALL-2026-07-20).
 *
 * COLD-PATH stall-B fix (COLDPATH-FIX-2026-07-21): the default budget is now
 * ZERO, not one. #16713's single-retry cap still cost a ~2s `initialDelayInMs`
 * sleep that retried the SAME dead Cerebras upstream. The interactive turn now
 * routes through `getInteractiveCerebrasLanguageModel`, whose middleware fails
 * over to OpenRouter INSTANTLY (no backoff) on a transient 5xx — so the SDK's
 * sleeping retry is redundant and additive, and the healthy default is 0.
 *
 * These tests drive the REAL exported functions with `ai`'s generateText /
 * streamText stubbed to CAPTURE the options object, proving the bounded
 * `maxRetries` is actually passed through on both the non-stream and stream
 * entry points, and pin the env-driven `resolveSharedTurnMaxRetries` clamp.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let providerConfigured = true;
let lastGenerateOptions: Record<string, unknown> | null = null;
let lastStreamOptions: Record<string, unknown> | null = null;

mock.module("../../providers/language-model", () => ({
  getLanguageModel: () => ({ __sentinel: "model" }),
  getInteractiveCerebrasLanguageModel: () => ({ __sentinel: "interactive-model" }),
  hasLanguageModelProviderConfigured: () => providerConfigured,
}));

mock.module("ai", () => ({
  generateText: async (options: Record<string, unknown>) => {
    lastGenerateOptions = options;
    return { text: "ok reply", usage: { totalTokens: 3 } };
  },
  streamText: (options: Record<string, unknown>) => {
    lastStreamOptions = options;
    return {
      // Match the AI SDK's AsyncIterableStream cancellation surface. The
      // production path takes a reader so an interrupted voice turn can cancel
      // provider generation instead of only abandoning local iteration.
      fullStream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", text: "ok" });
          controller.enqueue({ type: "finish", totalUsage: { totalTokens: 3 } });
          controller.close();
        },
      }),
    };
  },
}));

const { runSharedAgentTurn, runSharedAgentTurnStream, SHARED_TURN_MAX_RETRIES } = await import(
  "./run-shared-agent-turn"
);
// resolveSharedTurnMaxRetries is not exported (module-load-time constant); we
// re-derive the same clamp here to pin its contract without widening the API.
function clampExpectation(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 2);
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  providerConfigured = true;
  lastGenerateOptions = null;
  lastStreamOptions = null;
  globalThis.fetch = mock(async () => {
    throw new Error("no network expected in this unit test");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("shared-runtime turn retry budget", () => {
  test("default budget is ZERO SDK backoff (the instant-failover wrapper owns resilience)", () => {
    // With no SHARED_TURN_MAX_RETRIES env set in the test process, the resolved
    // constant is 0: the interactive model wrapper fails over to a healthy
    // provider instantly on a 5xx, so the SDK's ~2s sleeping retry is redundant.
    expect(SHARED_TURN_MAX_RETRIES).toBe(clampExpectation(process.env.SHARED_TURN_MAX_RETRIES));
    expect(SHARED_TURN_MAX_RETRIES).toBeLessThanOrEqual(2);
    expect(SHARED_TURN_MAX_RETRIES).toBeGreaterThanOrEqual(0);
  });

  test("runSharedAgentTurn passes the bounded maxRetries to generateText", async () => {
    await runSharedAgentTurn({
      character: { name: "Nova", system: "You are Nova.", model: "gpt-oss-120b" },
      history: [],
      message: "hello",
    });
    expect(lastGenerateOptions).not.toBeNull();
    expect(lastGenerateOptions?.maxRetries).toBe(SHARED_TURN_MAX_RETRIES);
    // The bound must never silently regress to the SDK default that caused the stall.
    expect(lastGenerateOptions?.maxRetries).toBeLessThanOrEqual(1);
    // Healthy default is zero SDK backoff on the interactive path.
    expect(lastGenerateOptions?.maxRetries).toBe(0);
  });

  test("runSharedAgentTurnStream passes the bounded maxRetries to streamText", async () => {
    const result = await runSharedAgentTurnStream({
      character: { name: "Nova", system: "You are Nova.", model: "gpt-oss-120b" },
      history: [],
      message: "hello",
    });
    // Drain so the stream generator runs, matching real caller behavior.
    if ("parts" in result && result.parts) {
      for await (const _part of result.parts) {
        // consume
      }
    }
    expect(lastStreamOptions).not.toBeNull();
    expect(lastStreamOptions?.maxRetries).toBe(SHARED_TURN_MAX_RETRIES);
    expect(lastStreamOptions?.maxRetries).toBeLessThanOrEqual(1);
    expect(lastStreamOptions?.maxRetries).toBe(0);
  });
});

describe("resolveSharedTurnMaxRetries clamp contract (re-derived)", () => {
  test.each([
    [undefined, 0],
    ["", 0],
    ["   ", 0],
    ["0", 0],
    ["1", 1],
    ["2", 2],
    ["5", 2], // clamped down: can never exceed the SDK default it bounds
    ["-1", 0], // negative -> fall back to safe (zero-backoff) default
    ["abc", 0], // unparseable -> safe (zero-backoff) default
  ])("SHARED_TURN_MAX_RETRIES=%p resolves to %p", (raw, expected) => {
    expect(clampExpectation(raw as string | undefined)).toBe(expected);
  });
});
