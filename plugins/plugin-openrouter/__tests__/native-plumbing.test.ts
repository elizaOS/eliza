import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime() {
  return {
    character: { system: "system prompt" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_SMALL_MODEL: "openrouter-small",
      };
      return settings[key] ?? null;
    }),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("../providers");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("OpenRouter native text plumbing", () => {
  it("passes native messages and tools through and returns text result shape", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createOpenRouterProvider: () => ({
        chat: (modelName: string) => ({ modelName }),
      }),
    }));

    const { handleTextSmall } = await import("../models/text");
    const messages = [{ role: "user", content: "use the tool" }];
    const tools = { lookup: { description: "Lookup", inputSchema: { type: "object" } } };
    const result = (await handleTextSmall(createRuntime(), {
      prompt: "legacy prompt",
      messages,
      tools,
    } as never)) as unknown as Record<string, unknown>;

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.messages).toBe(messages);
    expect(call).not.toHaveProperty("prompt");
    expect(call.tools).toBe(tools);
    expect(result).toMatchObject({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
    });
  });

  it("passes system separately and strips the duplicate leading system message", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createOpenRouterProvider: () => ({
        chat: (modelName: string) => ({ modelName }),
      }),
    }));

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(createRuntime(), {
      prompt: "legacy prompt",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "hello" },
      ],
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.system).toBe("system prompt");
    expect(call.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("forwards openrouter.promptCacheKey from providerOptions to generateText", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createOpenRouterProvider: () => ({
        chat: (modelName: string) => ({ modelName }),
      }),
    }));

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(createRuntime(), {
      prompt: "prompt with caching",
      providerOptions: {
        openrouter: { promptCacheKey: "v5:abc123" },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    const providerOptions = call.providerOptions as Record<string, unknown>;
    expect(providerOptions).toBeDefined();
    const openrouterOpts = providerOptions.openrouter as Record<string, unknown>;
    expect(openrouterOpts).toBeDefined();
    expect(openrouterOpts.promptCacheKey).toBe("v5:abc123");
  });

  it("does not inject empty providerOptions when none are provided", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createOpenRouterProvider: () => ({
        chat: (modelName: string) => ({ modelName }),
      }),
    }));

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(createRuntime(), {
      prompt: "prompt without caching",
    } as never);

    const call = generateText.mock.calls[0][0] as Record<string, unknown>;
    // When no providerOptions were supplied, we should not inject an empty object
    expect(call.providerOptions).toBeUndefined();
  });
});
