/**
 * Shape tests for the structured prompt-cache usage log emitted by
 * emitModelUsageEvent (#15742): every Anthropic call logs cache read/write
 * token counts with a hit/write/none classification so operators can spot a
 * cache miss on a prefix they expected to be warm. Deterministic — logger
 * spied, runtime mocked, no live API.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyPromptCacheUsage, emitModelUsageEvent } from "../utils/events";

function createRuntime() {
  return {
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyPromptCacheUsage", () => {
  it("classifies reads as hit, write-only as write, and no activity as none", () => {
    expect(classifyPromptCacheUsage(120, 0)).toBe("hit");
    expect(classifyPromptCacheUsage(120, 40)).toBe("hit");
    expect(classifyPromptCacheUsage(0, 500)).toBe("write");
    expect(classifyPromptCacheUsage(undefined, 500)).toBe("write");
    expect(classifyPromptCacheUsage(0, 0)).toBe("none");
    expect(classifyPromptCacheUsage(undefined, undefined)).toBe("none");
  });
});

describe("emitModelUsageEvent structured cache log (#15742)", () => {
  it("logs cache read/write counts and a hit classification on a warm call", () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});

    emitModelUsageEvent(
      createRuntime(),
      ModelType.TEXT_LARGE,
      "prompt",
      {
        promptTokens: 100,
        completionTokens: 10,
        totalTokens: 110,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 5,
      },
      "claude-test-large"
    );

    expect(debug).toHaveBeenCalledTimes(1);
    const [context, message] = debug.mock.calls[0] as [Record<string, unknown>, string];
    expect(context).toMatchObject({
      provider: "anthropic",
      model: "claude-test-large",
      promptTokens: 100,
      completionTokens: 10,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 5,
      cacheOutcome: "hit",
    });
    expect(message).toContain("[Anthropic] prompt cache hit");
    expect(message).toContain("read=80");
    expect(message).toContain("write=5");
  });

  it("logs a write classification on a cold prefix (the diagnosable miss)", () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});

    emitModelUsageEvent(
      createRuntime(),
      ModelType.TEXT_SMALL,
      "prompt",
      {
        promptTokens: 30,
        completionTokens: 3,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 900,
      },
      "claude-test-small"
    );

    const [context, message] = debug.mock.calls[0] as [Record<string, unknown>, string];
    expect(context).toMatchObject({
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 900,
      cacheOutcome: "write",
    });
    expect(message).toContain("[Anthropic] prompt cache write");
  });

  it("logs none (with zeroed counts) when the usage shape carries no cache fields", () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});

    emitModelUsageEvent(createRuntime(), ModelType.TEXT_SMALL, "prompt", {
      promptTokens: 12,
      completionTokens: 2,
    });

    const [context, message] = debug.mock.calls[0] as [Record<string, unknown>, string];
    expect(context).toMatchObject({
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheOutcome: "none",
    });
    expect(message).toContain("[Anthropic] prompt cache none");
  });

  it("still emits MODEL_USED with the same cache counts", () => {
    vi.spyOn(logger, "debug").mockImplementation(() => {});
    const runtime = createRuntime();

    emitModelUsageEvent(
      runtime,
      ModelType.TEXT_LARGE,
      "prompt",
      {
        promptTokens: 100,
        completionTokens: 10,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 5,
      },
      "claude-test-large"
    );

    const emitEvent = runtime.emitEvent as ReturnType<typeof vi.fn>;
    expect(emitEvent).toHaveBeenCalledTimes(1);
    const payload = emitEvent.mock.calls[0][1] as {
      tokens: Record<string, unknown>;
    };
    expect(payload.tokens).toMatchObject({
      prompt: 100,
      completion: 10,
      cacheRead: 80,
      cacheWrite: 5,
    });
  });
});
