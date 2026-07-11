/**
 * Regression coverage for the cache-write token drop: `ai@^6` reports cache-write
 * counts at `usage.inputTokenDetails.cacheWriteTokens`, not the `cacheCreationInputTokens`
 * top-level field both `emitModelUsageEvent` and `buildNativeTextResult` used to read (which
 * the SDK never populates). AI SDK and provider are mocked with a realistic `LanguageModelUsage`
 * shape — no network calls, deterministic fixtures.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractCacheTokens } from "../utils/events";

function createRuntime(settings: Record<string, string> = {}) {
  const emitEvent = vi.fn(async () => undefined);
  return {
    runtime: {
      character: { system: "system prompt" },
      emitEvent,
      getSetting: vi.fn((key: string) => {
        return (
          (
            {
              OPENROUTER_API_KEY: "test-key",
              OPENROUTER_LARGE_MODEL: "anthropic/claude-opus-4-8",
              ...settings,
            } as Record<string, string>
          )[key] ?? null
        );
      }),
    } as IAgentRuntime,
    emitEvent,
  };
}

// Shape actually produced by `ai@^6`'s `generateText`/`streamText` result for
// a provider that reports cache reuse — see `node_modules/ai/dist/index.js`
// `convertV3UsageToV4`/`convertUsage` and `index.d.ts:275-290`.
const realSdkUsage = {
  inputTokens: 9592,
  outputTokens: 219,
  totalTokens: 9811,
  cachedInputTokens: 0, // deprecated read-only alias — never carries write counts
  inputTokenDetails: {
    noCacheTokens: 727,
    cacheReadTokens: 0,
    cacheWriteTokens: 8865,
  },
};

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("../providers");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("extractCacheTokens", () => {
  it("reads cache-write tokens from inputTokenDetails.cacheWriteTokens (ai@^6 real shape)", () => {
    const { cacheRead, cacheCreation } = extractCacheTokens(realSdkUsage);
    expect(cacheCreation).toBe(8865);
    expect(cacheRead).toBe(0);
  });

  it("prefers the explicit cacheReadInputTokens field over inputTokenDetails when a caller sets it directly", () => {
    const { cacheRead } = extractCacheTokens({
      cacheReadInputTokens: 999,
      inputTokenDetails: { cacheReadTokens: 8865, cacheWriteTokens: 0 },
    });
    expect(cacheRead).toBe(999);
  });

  it("falls back to the legacy cacheCreationInputTokens field for callers that set it directly", () => {
    const { cacheCreation } = extractCacheTokens({ cacheCreationInputTokens: 1234 });
    expect(cacheCreation).toBe(1234);
  });

  it("returns undefined for both when no cache fields are present anywhere", () => {
    const { cacheRead, cacheCreation } = extractCacheTokens({
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
    });
    expect(cacheRead).toBeUndefined();
    expect(cacheCreation).toBeUndefined();
  });
});

describe("emitModelUsageEvent — cache-write tokens on the real ai@^6 usage shape", () => {
  it("includes cacheCreationInputTokens in the MODEL_USED payload and the returned NormalizedModelUsage", async () => {
    const { emitModelUsageEvent } = await import("../utils/events");
    const { runtime, emitEvent } = createRuntime();

    const result = emitModelUsageEvent(
      runtime,
      "RESPONSE_HANDLER" as never,
      "prompt",
      realSdkUsage,
      "anthropic/claude-opus-4-8",
      "RESPONSE_HANDLER"
    );

    expect(result.cacheCreationInputTokens).toBe(8865);
    expect(emitEvent).toHaveBeenCalledTimes(1);
    const payload = emitEvent.mock.calls[0][1] as { tokens?: Record<string, unknown> };
    expect(payload.tokens?.cacheCreationInputTokens).toBe(8865);
  });
});

describe("buildNativeTextResult (via handleTextLarge) — cache-write tokens on the real ai@^6 usage shape", () => {
  it("carries cacheCreationInputTokens through to the native result's usage field", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      finishReason: "stop",
      usage: realSdkUsage,
    }));
    vi.doMock("ai", () => ({ generateText, streamText: vi.fn() }));
    vi.doMock("../providers", () => ({
      createOpenRouterProvider: () => ({ chat: (m: string) => ({ modelName: m }) }),
    }));

    const { handleTextLarge } = await import("../models/text");
    const { runtime } = createRuntime();

    const result = (await handleTextLarge(runtime, {
      prompt: "hello",
      messages: [{ role: "user", content: "hello" }],
      tools: {},
    } as never)) as unknown as { usage?: { cacheCreationInputTokens?: number } };

    expect(result.usage?.cacheCreationInputTokens).toBe(8865);
  });

  it("preserves cache-write usage after a streaming response is consumed", async () => {
    const textStream = (async function* () {
      yield "cached ";
      yield "reply";
    })();
    const streamText = vi.fn(() => ({
      textStream,
      text: Promise.resolve("cached reply"),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve(realSdkUsage),
      finishReason: Promise.resolve("stop"),
    }));
    vi.doMock("ai", () => ({ generateText: vi.fn(), streamText }));
    vi.doMock("../providers", () => ({
      createOpenRouterProvider: () => ({ chat: (modelName: string) => ({ modelName }) }),
    }));

    const { handleTextLarge } = await import("../models/text");
    const { runtime, emitEvent } = createRuntime();
    const result = await handleTextLarge(runtime, {
      prompt: "hello",
      messages: [{ role: "user", content: "hello" }],
      tools: {},
      stream: true,
    } as never);
    if (typeof result === "string") throw new Error("expected streaming result");

    const chunks: string[] = [];
    for await (const chunk of result.textStream) chunks.push(chunk);

    expect(chunks).toEqual(["cached ", "reply"]);
    expect(await result.text).toBe("cached reply");
    expect(await result.usage).toEqual(expect.objectContaining({ cacheCreationInputTokens: 8865 }));
    expect(emitEvent).toHaveBeenCalledTimes(1);
  });

  it("routes every text model handler through the same accounting path", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      finishReason: "stop",
      usage: realSdkUsage,
    }));
    vi.doMock("ai", () => ({ generateText, streamText: vi.fn() }));
    vi.doMock("../providers", () => ({
      createOpenRouterProvider: () => ({ chat: (modelName: string) => ({ modelName }) }),
    }));

    const textModels = await import("../models/text");
    const { runtime, emitEvent } = createRuntime();
    const handlers = [
      textModels.handleTextSmall,
      textModels.handleTextNano,
      textModels.handleTextMedium,
      textModels.handleTextMega,
      textModels.handleResponseHandler,
      textModels.handleActionPlanner,
    ];

    for (const handler of handlers) {
      expect(await handler(runtime, { prompt: "hello" } as never)).toBe("ok");
    }
    expect(generateText).toHaveBeenCalledTimes(handlers.length);
    expect(emitEvent).toHaveBeenCalledTimes(handlers.length);
  });
});
