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

  it("stamps cache_control on stable segments when messages and promptSegments are both provided (planner v5 path)", async () => {
    // Regression for the v5 planner wire path.
    //
    // The planner-loop calls useModel with BOTH messages (system + user + assistant/tool
    // trajectory) AND promptSegments (the same content as labeled stable/dynamic parts).
    // Before this fix, the segmented userContent — which carries cache_control on stable
    // parts — was built and then discarded because the messages branch sent wireMessages
    // directly (plain string content, no breakpoints), and providerOptions.anthropic.
    // cacheControl was explicitly stripped. Net effect: zero cache_control blocks on
    // the wire for every planner / evaluator call.
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
    // Planner-shape inputs: messages built by buildStageChatMessages — leading system
    // message holds the stable runtime prefix + planner_stage instructions; the user
    // message holds the dynamic context; the trajectory follows as assistant/tool pairs.
    // promptSegments is the same content split into stable / dynamic parts.
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
        { content: "planner_stage:\nDo X.", stable: false },
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
      providerOptions?: Record<string, unknown>;
      tools?: unknown;
    };

    // The runtime stable prefix + stage instructions live inside the structured
    // user content (with cache_control on stable parts). Sending them ALSO via
    // the system parameter would double the prompt cost on cache misses and
    // contribute nothing on hits (the system parameter cannot carry
    // cache_control). Assert the system parameter is dropped on this path.
    expect(call.system).toBeUndefined();

    // The trajectory's assistant/tool pair must reach the wire untouched.
    const assistantTurn = call.messages.find((m) => m.role === "assistant");
    const toolTurn = call.messages.find((m) => m.role === "tool");
    expect(assistantTurn).toBeDefined();
    expect(toolTurn).toBeDefined();

    // The combined planner prefix (stable runtime + instructions + dynamic context)
    // must reach Anthropic with at least one cache_control breakpoint on a stable
    // part. Before the fix this assertion fails because cache_control never makes
    // it to the wire on the messages+promptSegments path.
    const allTextParts: Array<Record<string, unknown>> = [];
    for (const message of call.messages) {
      if (Array.isArray(message.content)) {
        for (const part of message.content as Array<Record<string, unknown>>) {
          if (part.type === "text") allTextParts.push(part);
        }
      }
    }
    const cacheControlled = allTextParts.filter((part) => part.cache_control);
    expect(cacheControlled.length).toBeGreaterThan(0);
    expect(cacheControlled.length).toBeLessThanOrEqual(4); // Anthropic per-call limit
    for (const part of cacheControlled) {
      expect((part.cache_control as Record<string, unknown>).type).toBe("ephemeral");
    }
    // The stable runtime prefix must be one of the cached blocks.
    const stableTextValues = cacheControlled.map((p) => p.text);
    expect(stableTextValues.some((t) => typeof t === "string" && t.includes("stable prefix"))).toBe(
      true
    );

    // Tools must still reach the wire and trigger native tool-calling.
    expect(call.tools).toBe(tools);
  }, 60_000);

  it("coalesces cache_control to at most 4 breakpoints when many stable segments are provided", async () => {
    // Anthropic returns 400 if a request carries more than 4 cache_control
    // breakpoints. A realistic v5 planner call has 5-9 stable segments
    // (staticPrefix.systemPrompt, characterPrompt, staticProviders,
    // messageHandlerThought, selectedContexts, contextDefinitions,
    // contextProviders, planner_stage instructions, ...) so naive per-segment
    // stamping would always trip the limit. We expect the LAST 4 stable
    // segments to be marked, and everything else (stable or not) to ride along
    // unmarked inside whichever cached prefix matches at request time.
    const generateText = vi.fn(async () => ({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 1 },
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
      prompt: "ignored",
      promptSegments: [
        { content: "stable A", stable: true },
        { content: "stable B", stable: true },
        { content: "stable C", stable: true },
        { content: "dynamic 1", stable: false },
        { content: "stable D", stable: true },
        { content: "stable E", stable: true },
        { content: "stable F", stable: true },
        { content: "dynamic 2", stable: false },
      ],
      providerOptions: {
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as {
      messages: Array<{ content: Array<Record<string, unknown>> }>;
    };
    const allParts = call.messages[0].content;
    const marked = allParts.filter((p) => p.cache_control);
    expect(marked.length).toBeLessThanOrEqual(4);
    expect(marked.length).toBe(4);
    // The marked parts must be the LAST four stable segments — that placement
    // gives the longest matching cached prefix on subsequent calls.
    const markedTexts = marked.map((p) => p.text);
    expect(markedTexts).toEqual(["stable C", "stable D", "stable E", "stable F"]);
  }, 60_000);
});
