import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

function createRuntime() {
  return {
    character: { name: "Claude Agent", system: "system prompt" },
    emitEvent: vi.fn(),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_SMALL_MODEL: "claude-test-small",
      };
      return settings[key];
    }),
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("../providers");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Anthropic native text plumbing", () => {
  it("preserves prompt segment cache_control and returns cache usage with native tools", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      toolCalls: [{ toolName: "lookup", input: { q: "x" } }],
      finishReason: "tool-calls",
      usage: {
        inputTokens: 11,
        outputTokens: 4,
        cacheReadInputTokens: 6,
        cacheCreationInputTokens: 8,
      },
    }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createAnthropicClientWithTopPSupport: () => (modelName: string) => ({ modelName }),
    }));

    const { handleTextSmall } = await import("../models/text");
    const tools = { lookup: { description: "Lookup", inputSchema: { type: "object" } } };
    const result = (await handleTextSmall(createRuntime(), {
      prompt: "stableunstable",
      promptSegments: [
        { content: "stable", stable: true },
        { content: "unstable", stable: false },
      ],
      tools,
      providerOptions: {
        agentName: "Claude Agent",
        anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } },
      },
    } as never)) as unknown as Record<string, unknown>;

    const call = generateText.mock.calls[0][0] as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
      providerOptions?: Record<string, unknown>;
      tools?: unknown;
    };
    expect(call.tools).toBe(tools);
    expect(call.messages[0].content).toEqual([
      { type: "text", text: "stable", cache_control: { type: "ephemeral", ttl: "5m" } },
      { type: "text", text: "unstable" },
    ]);
    expect(call.providerOptions).toEqual({ anthropic: { cacheControl: undefined } });
    expect(result).toMatchObject({
      text: "ok",
      finishReason: "tool-calls",
      usage: {
        promptTokens: 11,
        completionTokens: 4,
        totalTokens: 15,
        cacheReadInputTokens: 6,
        cacheCreationInputTokens: 8,
      },
    });
  }, 60_000);

  it("passes system separately and strips the duplicate leading system message", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 4, outputTokens: 1 },
    }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createAnthropicClientWithTopPSupport: () => (modelName: string) => ({ modelName }),
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

  it("emits cache_control on stable segments even without ANTHROPIC_PROMPT_CACHE_TTL env var", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 2 },
    }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createAnthropicClientWithTopPSupport: () => (modelName: string) => ({ modelName }),
    }));

    // Runtime with NO ANTHROPIC_PROMPT_CACHE_TTL setting — cache_control must still fire
    const runtimeNoCacheTtl = {
      character: { name: "Claude Agent", system: "system prompt" },
      emitEvent: vi.fn(),
      getSetting: vi.fn((key: string) => {
        const settings: Record<string, string> = {
          ANTHROPIC_API_KEY: "test-key",
          ANTHROPIC_SMALL_MODEL: "claude-test-small",
        };
        return settings[key] ?? null;
      }),
    } as unknown as IAgentRuntime;

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(runtimeNoCacheTtl, {
      prompt: "test",
      promptSegments: [
        { content: "stable content", stable: true },
        { content: "dynamic content", stable: false },
      ],
    } as never);

    const call = generateText.mock.calls[0][0] as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    // The stable segment MUST carry cache_control even with no env var set
    const stableBlock = call.messages[0].content[0];
    expect(stableBlock.cache_control).toBeDefined();
    expect((stableBlock.cache_control as Record<string, unknown>).type).toBe("ephemeral");
    // The non-stable segment must NOT carry cache_control
    const dynamicBlock = call.messages[0].content[1];
    expect(dynamicBlock.cache_control).toBeUndefined();
  }, 60_000);

  it("applies 1h TTL when ANTHROPIC_PROMPT_CACHE_TTL=1h is set", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 5, outputTokens: 2 },
    }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createAnthropicClientWithTopPSupport: () => (modelName: string) => ({ modelName }),
    }));

    const runtime1h = {
      character: { name: "Claude Agent", system: "system prompt" },
      emitEvent: vi.fn(),
      getSetting: vi.fn((key: string) => {
        const settings: Record<string, string> = {
          ANTHROPIC_API_KEY: "test-key",
          ANTHROPIC_SMALL_MODEL: "claude-test-small",
          ANTHROPIC_PROMPT_CACHE_TTL: "1h",
        };
        return settings[key] ?? null;
      }),
    } as unknown as IAgentRuntime;

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(runtime1h, {
      prompt: "test",
      promptSegments: [{ content: "stable content", stable: true }],
    } as never);

    const call = generateText.mock.calls[0][0] as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const stableBlock = call.messages[0].content[0];
    expect((stableBlock.cache_control as Record<string, unknown>).type).toBe("ephemeral");
    expect((stableBlock.cache_control as Record<string, unknown>).ttl).toBe("1h");
  }, 60_000);
});
