/**
 * Rate-limit handling shape for the text handlers: the AI SDK's built-in
 * retry (which honors a provider `Retry-After` of up to 60 s inside one model
 * call) is disabled on every generateText/streamText request, and the plugin's
 * transient lane refuses to retry a 429 whose `Retry-After` outlasts its 3 s
 * backoff cap so the runtime can fail over to another model at once. The AI SDK
 * and provider client are mocked; no network.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aiMocks = vi.hoisted(() => ({
  generateText: vi.fn(),
  streamText: vi.fn(),
}));

import {
  handleTextLarge,
  handleTextSmall,
  __INTERNAL_isTransientProviderError as isTransientProviderError,
  __INTERNAL_resetRateLimitCooldowns as resetRateLimitCooldowns,
} from "../models/text";

vi.mock("ai", () => ({
  generateText: aiMocks.generateText,
  streamText: aiMocks.streamText,
  jsonSchema: (schema: unknown) => ({ jsonSchema: schema }),
  Output: {
    object: () => ({ name: "object", responseFormat: Promise.resolve({ type: "json" }) }),
    json: () => ({ name: "json", responseFormat: Promise.resolve({ type: "json" }) }),
  },
  RetryError: { isInstance: () => false },
}));

vi.mock("../providers", () => ({
  createOpenAIClient: () => ({
    chat: (modelName: string) => ({ modelName }),
    responses: (modelName: string) => ({ modelName }),
  }),
}));

function createRuntime(): IAgentRuntime {
  return {
    character: { name: "Ada", system: "system prompt" },
    emitEvent: vi.fn(),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn(() => undefined),
  } as unknown as IAgentRuntime;
}

beforeEach(() => {
  resetRateLimitCooldowns();
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_BASE_URL", "https://api.cerebras.ai/v1");
  vi.stubEnv("OPENAI_SMALL_MODEL", "gemma-4-31b");
  vi.stubEnv("OPENAI_LARGE_MODEL", "qwen-3.8-27b");
  aiMocks.generateText.mockResolvedValue({
    text: "ok",
    finishReason: "stop",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("SDK retry ownership", () => {
  it("sends every generateText request with maxRetries 0", async () => {
    await handleTextSmall(createRuntime(), { prompt: "hi" });
    expect(aiMocks.generateText).toHaveBeenCalledTimes(1);
    expect(aiMocks.generateText.mock.calls[0][0]).toMatchObject({ maxRetries: 0 });
  });
});

describe("429 transient classification", () => {
  it("does not retry a 429 whose Retry-After outlasts the lane's backoff cap", () => {
    // Live 2026-09-05: Cerebras per-minute bucket answered with retry-after 59/60.
    expect(
      isTransientProviderError({
        statusCode: 429,
        message: "Too Many Requests",
        responseHeaders: { "retry-after": "59" },
      })
    ).toBe(false);
    expect(
      isTransientProviderError({
        statusCode: 429,
        message: "Too Many Requests",
        responseHeaders: { "Retry-After": "60" },
      })
    ).toBe(false);
  });

  it("still retries a burst 429 with no or a short Retry-After", () => {
    expect(isTransientProviderError({ statusCode: 429, message: "Too Many Requests" })).toBe(true);
    expect(
      isTransientProviderError({
        statusCode: 429,
        message: "Too Many Requests",
        responseHeaders: { "retry-after": "2" },
      })
    ).toBe(true);
  });

  it("keeps retrying 5xx and 408/409 unchanged", () => {
    expect(isTransientProviderError({ statusCode: 503, message: "unavailable" })).toBe(true);
    expect(isTransientProviderError({ statusCode: 408, message: "timeout" })).toBe(true);
    expect(isTransientProviderError({ statusCode: 400, message: "invalid schema" })).toBe(false);
  });
});

describe("per-model rate-limit cooldown", () => {
  function bucketExhausted() {
    return Object.assign(new Error("Too Many Requests"), {
      statusCode: 429,
      responseHeaders: { "retry-after": "59" },
    });
  }

  it("holds a model after a bucket 429 instead of re-sending, and keeps other models live", async () => {
    aiMocks.generateText.mockRejectedValueOnce(bucketExhausted());
    await expect(handleTextSmall(createRuntime(), { prompt: "one" })).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(aiMocks.generateText).toHaveBeenCalledTimes(1);

    // Same concrete model (gemma-4-31b) through the same handler: no HTTP call.
    await expect(handleTextSmall(createRuntime(), { prompt: "two" })).rejects.toMatchObject({
      statusCode: 429,
      name: "ProviderRateLimitCooldownError",
    });
    expect(aiMocks.generateText).toHaveBeenCalledTimes(1);

    // A different concrete model (qwen-3.8-27b) is not held.
    await handleTextLarge(createRuntime(), { prompt: "three" });
    expect(aiMocks.generateText).toHaveBeenCalledTimes(2);
  });

  it("does not hold a model after a burst 429 without a long Retry-After", async () => {
    aiMocks.generateText.mockRejectedValueOnce(
      Object.assign(new Error("Too Many Requests"), { statusCode: 429 })
    );
    // The transient lane retries this class; the second attempt succeeds.
    await handleTextSmall(createRuntime(), { prompt: "one" });
    expect(aiMocks.generateText).toHaveBeenCalledTimes(2);
    await handleTextSmall(createRuntime(), { prompt: "two" });
    expect(aiMocks.generateText).toHaveBeenCalledTimes(3);
  });
});
