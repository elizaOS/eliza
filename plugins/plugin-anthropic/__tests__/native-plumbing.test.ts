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
  it("preserves prompt segment cache metadata and returns cache usage with native tools", async () => {
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
      system?: unknown;
      providerOptions?: Record<string, unknown>;
      tools?: unknown;
    };
    expect(call.tools).toBe(tools);
    expect(call.messages[0].content).toEqual([
      {
        type: "text",
        text: "stable",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
      },
      { type: "text", text: "unstable" },
    ]);
    expect(call.system).toEqual({
      role: "system",
      content: "system prompt",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } },
    });
    expect(call.providerOptions).toBeUndefined();
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
    expect(call.system).toEqual({
      role: "system",
      content: "system prompt",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(call.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("emits cache metadata on planned stable segments even without ANTHROPIC_PROMPT_CACHE_TTL env var", async () => {
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

    // Runtime with NO ANTHROPIC_PROMPT_CACHE_TTL setting: cache metadata must still fire.
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
      providerOptions: {
        anthropic: {
          cacheBreakpoints: [{ segmentIndex: 0, ttl: "short" }],
          maxBreakpoints: 4,
        },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
      system?: unknown;
    };
    // The stable segment must carry AI SDK-native cache metadata even with no env var set.
    const stableBlock = call.messages[0].content[0];
    expect(stableBlock.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    expect(call.system).toEqual({
      role: "system",
      content: "system prompt",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    // The non-stable segment must not carry cache metadata.
    const dynamicBlock = call.messages[0].content[1];
    expect(dynamicBlock.providerOptions).toBeUndefined();
  }, 60_000);

  it("caps fallback prompt segment cache markers to three plus system", async () => {
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

    const { handleTextSmall } = await import("../models/text");
    await handleTextSmall(createRuntime(), {
      prompt: "abcdef",
      promptSegments: [
        { content: "a", stable: true },
        { content: "b", stable: true },
        { content: "c", stable: true },
        { content: "d", stable: true },
        { content: "e", stable: true },
        { content: "f", stable: false },
      ],
    } as never);

    const call = generateText.mock.calls[0][0] as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
      system?: unknown;
    };
    const marked = call.messages[0].content.filter((part) => part.providerOptions);
    expect(call.system).toEqual({
      role: "system",
      content: "system prompt",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    expect(marked).toHaveLength(3);
    // We now select the LAST N stable segments (longer matching prefix on
    // subsequent calls). With segments [a*, b*, c*, d*, e*, f] and a 3-slot
    // budget, c/d/e are marked and a/b are unmarked.
    expect(call.messages[0].content[0]?.providerOptions).toBeUndefined();
    expect(call.messages[0].content[1]?.providerOptions).toBeUndefined();
    const markedTexts = marked.map((p) => p.text);
    expect(markedTexts).toEqual(["c", "d", "e"]);
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
      system?: unknown;
    };
    const stableBlock = call.messages[0].content[0];
    expect(stableBlock.providerOptions).toMatchObject({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
    expect(call.system).toEqual({
      role: "system",
      content: "system prompt",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
    });
  }, 60_000);
});

describe("Anthropic model defaults", () => {
  it("defaults response handler to Haiku and action planner to Opus while preserving env overrides", async () => {
    const { getActionPlannerModel, getResponseHandlerModel } = await import("../utils/config");
    const runtime = {
      getSetting: vi.fn(() => undefined),
    } as unknown as IAgentRuntime;

    expect(getResponseHandlerModel(runtime)).toBe("claude-haiku-4-5-20251001");
    expect(getActionPlannerModel(runtime)).toBe("claude-opus-4-7");

    const overrideRuntime = {
      getSetting: vi.fn((key: string) => {
        const settings: Record<string, string> = {
          ANTHROPIC_RESPONSE_HANDLER_MODEL: "custom-haiku",
          ANTHROPIC_ACTION_PLANNER_MODEL: "custom-opus",
        };
        return settings[key];
      }),
    } as unknown as IAgentRuntime;
    expect(getResponseHandlerModel(overrideRuntime)).toBe("custom-haiku");
    expect(getActionPlannerModel(overrideRuntime)).toBe("custom-opus");
  });

  it("injects segmented userContent into the wire when both messages and promptSegments are provided (planner v5 path)", async () => {
    // Regression: before this fix, when the planner-loop / evaluator passed BOTH
    // `messages` and `promptSegments`, the segmented userContent (with cache_control
    // on stable parts) was built and discarded — the wire only saw the flat-string
    // `wireMessages`. Result: zero cache_control breakpoints reached the wire on
    // every planner / evaluator call, and Anthropic prompt caching was silently inert.
    const generateText = vi.fn(async () => ({
      text: "ok",
      toolCalls: [{ toolName: "READ", input: { path: "x" } }],
      finishReason: "tool-calls",
      usage: {
        inputTokens: 100,
        outputTokens: 4,
        cacheReadInputTokens: 80,
        cacheCreationInputTokens: 20,
      },
    }));
    vi.doMock("ai", () => ({
      generateText,
      streamText: vi.fn(),
    }));
    vi.doMock("../providers", () => ({
      createAnthropicClientWithTopPSupport: () => (modelName: string) => ({ modelName }),
    }));

    const { handleActionPlanner } = await import("../models/text");
    const tools = { READ: { description: "Read a file", inputSchema: { type: "object" } } };
    await handleActionPlanner(createRuntime(), {
      prompt: "ignored when messages provided",
      messages: [
        { role: "system", content: "stable prefix\n\nplanner_stage:\nDo X." },
        { role: "user", content: "dynamic context" },
        {
          role: "assistant",
          content: "thinking",
          toolCalls: [{ id: "tc-1", type: "function", name: "READ", arguments: "{}" }],
        },
        { role: "tool", toolCallId: "tc-1", name: "READ", content: "ok" },
      ],
      promptSegments: [
        { content: "stable prefix", stable: true },
        { content: "dynamic context", stable: false },
        { content: "planner_stage:\nDo X.", stable: true },
      ],
      tools,
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    } as never);

    expect(generateText).toHaveBeenCalledTimes(1);
    const call = generateText.mock.calls[0][0] as {
      system?: unknown;
      messages: Array<{ role: string; content: unknown }>;
      tools?: unknown;
    };

    // The segmented user content (with cache_control on stable parts) is now
    // the first user message. The dynamic-only user message synthesized into
    // wireMessages is dropped (its content is fully covered by promptSegments).
    const firstUser = call.messages.find((m) => m.role === "user");
    expect(firstUser).toBeDefined();
    expect(Array.isArray(firstUser?.content)).toBe(true);

    // The trajectory's assistant/tool pair must reach the wire untouched.
    const assistantTurn = call.messages.find((m) => m.role === "assistant");
    const toolTurn = call.messages.find((m) => m.role === "tool");
    expect(assistantTurn).toBeDefined();
    expect(toolTurn).toBeDefined();

    // Stable segments carry cache_control on the wire.
    const allTextParts: Array<Record<string, unknown>> = [];
    for (const message of call.messages) {
      if (Array.isArray(message.content)) {
        for (const part of message.content as Array<Record<string, unknown>>) {
          if (part.type === "text") allTextParts.push(part);
        }
      }
    }
    const cached = allTextParts.filter((part) => part.providerOptions);
    expect(cached.length).toBeGreaterThan(0);
    expect(cached.length).toBeLessThanOrEqual(4);
    const cachedTexts = cached.map((p) => p.text);
    expect(
      cachedTexts.some((t) => typeof t === "string" && t.includes("planner_stage")),
    ).toBe(true);

    // Tools still reach the wire.
    expect(call.tools).toBe(tools);
  }, 60_000);
});
