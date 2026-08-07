/**
 * Shape tests for `emitModelUsageEvent`: the MODEL_USED emission that converts
 * token usage from the three shapes the plugin sees (local TokenUsage, AI SDK
 * usage, raw OpenAI API usage) into one payload. Focus is the regression
 * witness that hidden reasoning tokens survive onto `payload.tokens.reasoningTokens`
 * after `normalizeUsage` (utils/events.ts) — a field that was dropped before
 * PR #17783, making the event-path spread dead code.
 */

import { EventType, ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRetryTelemetry } from "../utils/events";
import { emitModelUsageEvent } from "../utils/events";

function createRuntime() {
  return {
    character: { name: "Ada" },
    emitEvent: vi.fn(async () => undefined),
    // emitModelUsageEvent → getUsageProvider → getSetting/isCerebrasMode read
    // provider mode off the runtime; a bare mock returns undefined, which
    // means "no override" (default openai provider) — the expected path.
    getSetting: vi.fn(() => undefined),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
  } as never;
}

function findModelUsedPayload(runtime: { emitEvent: ReturnType<typeof vi.fn> }) {
  const call = runtime.emitEvent.mock.calls.find(([event]) => event === EventType.MODEL_USED);
  if (!call) {
    throw new Error("MODEL_USED was never emitted");
  }
  return call[1] as { tokens: Record<string, number> };
}

beforeEach(() => {
  vi.stubEnv("OPENAI_BASE_URL", "");
  vi.stubEnv("ELIZA_PROVIDER", "");
  vi.stubEnv("CEREBRAS_API_KEY", "");
});

describe("emitModelUsageEvent — reasoningTokens on MODEL_USED", () => {
  it("carries reasoningTokens when AI SDK usage reports outputTokenDetails.reasoningTokens", () => {
    const runtime = createRuntime();
    emitModelUsageEvent(
      runtime,
      ModelType.TEXT_LARGE,
      "burst",
      {
        // AI SDK shape: inputTokens/outputTokens + detail block
        inputTokens: 10,
        outputTokens: 407,
        outputTokenDetails: { reasoningTokens: 400 },
      },
      "gpt-test-large"
    );

    const payload = findModelUsedPayload(runtime);
    expect(payload.tokens.reasoningTokens).toBe(400);
  });

  it("prefers outputTokenDetails.reasoningTokens over a top-level reasoningTokens on AI SDK usage", () => {
    const runtime = createRuntime();
    emitModelUsageEvent(
      runtime,
      ModelType.TEXT_LARGE,
      "burst",
      {
        inputTokens: 10,
        outputTokens: 407,
        reasoningTokens: 7,
        outputTokenDetails: { reasoningTokens: 400 },
      },
      "gpt-test-large"
    );

    const payload = findModelUsedPayload(runtime);
    expect(payload.tokens.reasoningTokens).toBe(400);
  });

  it("falls back to top-level reasoningTokens on AI SDK usage when detail block is absent", () => {
    const runtime = createRuntime();
    emitModelUsageEvent(
      runtime,
      ModelType.TEXT_LARGE,
      "burst",
      {
        inputTokens: 10,
        outputTokens: 407,
        reasoningTokens: 5,
      },
      "gpt-test-large"
    );

    const payload = findModelUsedPayload(runtime);
    expect(payload.tokens.reasoningTokens).toBe(5);
  });

  it("carries reasoningTokens when raw OpenAI API usage reports reasoningTokens", () => {
    const runtime = createRuntime();
    emitModelUsageEvent(
      runtime,
      ModelType.TEXT_LARGE,
      "burst",
      {
        // OpenAI API shape: promptTokens/completionTokens
        promptTokens: 10,
        completionTokens: 407,
        totalTokens: 417,
        reasoningTokens: 5,
      },
      "gpt-test-large"
    );

    const payload = findModelUsedPayload(runtime);
    expect(payload.tokens.reasoningTokens).toBe(5);
  });

  it("keeps reasoningTokens absent when the usage object reports none (missing stays missing)", () => {
    const runtime = createRuntime();
    emitModelUsageEvent(
      runtime,
      ModelType.TEXT_SMALL,
      "plain",
      {
        inputTokens: 2,
        outputTokens: 1,
      },
      "gpt-test-small"
    );

    const payload = findModelUsedPayload(runtime);
    // Absent — never zero — so a plain-text call is distinguishable from a
    // confirmed-none (thinking=off) call. This is the design contract.
    expect(payload.tokens).not.toHaveProperty("reasoningTokens");
  });

  it("keeps reasoningTokens absent for a plain prompt/completion usage shape", () => {
    const runtime = createRuntime();
    emitModelUsageEvent(
      runtime,
      ModelType.TEXT_SMALL,
      "plain",
      {
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
      },
      "gpt-test-small"
    );

    const payload = findModelUsedPayload(runtime);
    expect(payload.tokens).not.toHaveProperty("reasoningTokens");
  });

  it("rejects non-finite / negative reasoningTokens and keeps the field absent (no poisoned zero)", () => {
    const runtime = createRuntime();
    emitModelUsageEvent(
      runtime,
      ModelType.TEXT_LARGE,
      "burst",
      {
        inputTokens: 10,
        outputTokens: 407,
        // Same finite-non-negative discipline readReasoningTokensFromResponse
        // establishes: NaN, Infinity, and negatives → undefined.
        reasoningTokens: Number.NaN,
        outputTokenDetails: { reasoningTokens: -1 },
      },
      "gpt-test-large"
    );

    const payload = findModelUsedPayload(runtime);
    expect(payload.tokens).not.toHaveProperty("reasoningTokens");
  });

  it("confirms zero (thinking=off proof): a real attributable 0 is emitted, not dropped", () => {
    const runtime = createRuntime();
    emitModelUsageEvent(
      runtime,
      ModelType.TEXT_SMALL,
      "thinking-off",
      {
        inputTokens: 2,
        outputTokens: 1,
        outputTokenDetails: { reasoningTokens: 0 },
      },
      "gpt-test-small"
    );

    const payload = findModelUsedPayload(runtime);
    expect(payload.tokens.reasoningTokens).toBe(0);
  });

  it("still emits the base token fields alongside reasoningTokens", () => {
    const runtime = createRuntime();
    const retry: ModelRetryTelemetry = { retryCount: 1, lastRetryReason: "5xx" };
    emitModelUsageEvent(
      runtime,
      ModelType.TEXT_LARGE,
      "burst",
      {
        inputTokens: 10,
        outputTokens: 407,
        cachedInputTokens: 4,
        outputTokenDetails: { reasoningTokens: 400 },
      },
      "gpt-test-large",
      retry
    );

    const payload = findModelUsedPayload(runtime);
    expect(payload.tokens).toMatchObject({
      prompt: 10,
      completion: 407,
      total: 417,
      cached: 4,
      cachedInputTokens: 4,
      cacheReadInputTokens: 4,
      reasoningTokens: 400,
    });
  });
});
