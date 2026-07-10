/**
 * Shape tests for the Anthropic prompt-cache breakpoint budget (#15742):
 * tools-array tail breakpoint, kept-trajectory tail breakpoint, segment-budget
 * rebalancing under the four-breakpoint API cap, per-call opt-outs, and cache
 * read/write token propagation into MODEL_USED. Drives the real handlers
 * against a mocked runtime and AI SDK — no live API.
 */
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
  } as IAgentRuntime;
}

type WirePart = {
  type?: string;
  text?: string;
  providerOptions?: { anthropic?: { cacheControl?: unknown } };
};
type WireMessage = { role: string; content: unknown };
type WireTool = {
  providerOptions?: { anthropic?: { cacheControl?: unknown } };
};
type WireCall = {
  system?: { providerOptions?: { anthropic?: { cacheControl?: unknown } } };
  messages?: WireMessage[];
  tools?: Record<string, WireTool>;
};

/**
 * Count every cache_control breakpoint the request would place on the wire:
 * system + tool definitions + message content parts. Anthropic rejects more
 * than four; the adapter must never exceed the budget in ANY configuration.
 */
function countCacheControls(call: WireCall): number {
  let count = 0;
  if (call.system?.providerOptions?.anthropic?.cacheControl) {
    count += 1;
  }
  for (const tool of Object.values(call.tools ?? {})) {
    if (tool?.providerOptions?.anthropic?.cacheControl) {
      count += 1;
    }
  }
  for (const message of call.messages ?? []) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content as WirePart[]) {
      if (part?.providerOptions?.anthropic?.cacheControl) {
        count += 1;
      }
    }
  }
  return count;
}

function mockAiSdk() {
  const generateText = vi.fn(async () => ({
    text: "ok",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 5, outputTokens: 2 },
  }));
  vi.doMock("ai", () => ({
    generateText,
    streamText: vi.fn(),
  }));
  vi.doMock("../providers/anthropic", () => ({
    createAnthropicClientWithTopPSupport: () => (modelName: string) => ({
      modelId: modelName,
    }),
  }));
  return generateText;
}

const TRAJECTORY_MESSAGES = [
  { role: "user", content: [{ type: "text", text: "dynamic context" }] },
  {
    role: "assistant",
    content: [
      { type: "text", text: "first thought" },
      { type: "tool-call", toolCallId: "tc-1", toolName: "READ", input: { path: "a" } },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "tc-1",
        toolName: "READ",
        output: { type: "text", value: "first result" },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "second thought" },
      { type: "tool-call", toolCallId: "tc-2", toolName: "READ", input: { path: "b" } },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "tc-2",
        toolName: "READ",
        output: { type: "text", value: "second result" },
      },
    ],
  },
];

afterEach(() => {
  vi.doUnmock("ai");
  vi.doUnmock("../providers/anthropic");
  vi.clearAllMocks();
  vi.resetModules();
});

describe("Anthropic cache breakpoint budget (#15742)", () => {
  it("stamps the LAST tool with cache_control and rebalances segments to two when tools are present", async () => {
    const generateText = mockAiSdk();
    const { handleTextSmall } = await import("../models/text");

    const tools = {
      READ: { description: "Read", inputSchema: { type: "object" } },
      WRITE: { description: "Write", inputSchema: { type: "object" } },
    };
    await handleTextSmall(createRuntime(), {
      prompt: "abcde",
      promptSegments: [
        { content: "a", stable: true },
        { content: "b", stable: true },
        { content: "c", stable: true },
        { content: "d", stable: true },
        { content: "e", stable: false },
      ],
      tools,
    } as never);

    const call = generateText.mock.calls[0][0] as WireCall;
    // Only the LAST tool carries the breakpoint.
    expect(call.tools?.READ?.providerOptions).toBeUndefined();
    expect(call.tools?.WRITE?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    // Segment budget rebalanced: 4 total - system - tools = 2, and the LAST
    // two stable segments win (longest matching prefix on the next call).
    const parts = (call.messages?.[0]?.content ?? []) as WirePart[];
    const marked = parts.filter((part) => part.providerOptions);
    expect(marked.map((part) => part.text)).toEqual(["c", "d"]);
    expect(countCacheControls(call)).toBe(4);
  }, 60_000);

  it("keeps three segment breakpoints when no tools are present (regression: budget unchanged)", async () => {
    const generateText = mockAiSdk();
    const { handleTextSmall } = await import("../models/text");

    await handleTextSmall(createRuntime(), {
      prompt: "abcde",
      promptSegments: [
        { content: "a", stable: true },
        { content: "b", stable: true },
        { content: "c", stable: true },
        { content: "d", stable: true },
        { content: "e", stable: false },
      ],
    } as never);

    const call = generateText.mock.calls[0][0] as WireCall;
    const parts = (call.messages?.[0]?.content ?? []) as WirePart[];
    const marked = parts.filter((part) => part.providerOptions);
    expect(marked.map((part) => part.text)).toEqual(["b", "c", "d"]);
    expect(countCacheControls(call)).toBe(4);
  }, 60_000);

  it("keeps the highest-index planned breakpoints when the tools breakpoint shrinks the budget", async () => {
    const generateText = mockAiSdk();
    const { handleTextSmall } = await import("../models/text");

    const tools = { READ: { description: "Read", inputSchema: { type: "object" } } };
    await handleTextSmall(createRuntime(), {
      prompt: "abcde",
      promptSegments: [
        { content: "a", stable: true },
        { content: "b", stable: false },
        { content: "c", stable: true },
        { content: "d", stable: false },
        { content: "e", stable: true },
      ],
      tools,
      providerOptions: {
        anthropic: {
          cacheBreakpoints: [
            { segmentIndex: 0, ttl: "short" },
            { segmentIndex: 2, ttl: "short" },
            { segmentIndex: 4, ttl: "short" },
          ],
          maxBreakpoints: 4,
        },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as WireCall;
    const parts = (call.messages?.[0]?.content ?? []) as WirePart[];
    const markedTexts = parts.filter((part) => part.providerOptions).map((part) => part.text);
    // Budget is 2 after the tools reservation: the two LATEST planned
    // breakpoints (segments "c" and "e") survive; "a" is dropped.
    expect(markedTexts).toEqual(["c", "e"]);
    expect(countCacheControls(call)).toBe(4);
  }, 60_000);

  it("stamps the trajectory tail (last tool-result part) on the planner messages path and moves it as the trajectory grows", async () => {
    const generateText = mockAiSdk();
    const { handleActionPlanner } = await import("../models/text");

    const tools = { READ: { description: "Read", inputSchema: { type: "object" } } };
    await handleActionPlanner(createRuntime(), {
      prompt: "ignored when messages provided",
      messages: TRAJECTORY_MESSAGES,
      tools,
    } as never);

    const call = generateText.mock.calls[0][0] as WireCall;
    const messages = call.messages ?? [];
    expect(messages).toHaveLength(TRAJECTORY_MESSAGES.length);

    // Only the FINAL tool-result part carries the trajectory breakpoint —
    // the earlier pair (the old tail from the previous iteration's shape)
    // must not: as the window slides the stamp moves to the new tail.
    const firstToolParts = messages[2]?.content as WirePart[];
    expect(firstToolParts[0]?.providerOptions).toBeUndefined();
    const lastToolParts = messages[4]?.content as WirePart[];
    expect(lastToolParts[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
    // The dynamic leading user message must never be stamped.
    const userParts = messages[0]?.content as WirePart[];
    expect(userParts[0]?.providerOptions).toBeUndefined();
    // system(1) + tools(1) + trajectory(1) = 3 — within the API cap.
    expect(countCacheControls(call)).toBe(3);
  }, 60_000);

  it("does not stamp a user-tail message (volatile content must never be cached)", async () => {
    const generateText = mockAiSdk();
    const { handleTextSmall } = await import("../models/text");

    await handleTextSmall(createRuntime(), {
      prompt: "ignored",
      messages: [{ role: "user", content: [{ type: "text", text: "fresh question" }] }],
    } as never);

    const call = generateText.mock.calls[0][0] as WireCall;
    const parts = (call.messages?.[0]?.content ?? []) as WirePart[];
    expect(parts[0]?.providerOptions).toBeUndefined();
    // Only the system breakpoint remains.
    expect(countCacheControls(call)).toBe(1);
  }, 60_000);

  it("honors cacheTools=false and cacheTrajectory=false opt-outs", async () => {
    const generateText = mockAiSdk();
    const { handleActionPlanner } = await import("../models/text");

    const tools = { READ: { description: "Read", inputSchema: { type: "object" } } };
    await handleActionPlanner(createRuntime(), {
      prompt: "ignored when messages provided",
      messages: TRAJECTORY_MESSAGES,
      tools,
      providerOptions: {
        anthropic: {
          cacheControl: { type: "ephemeral" },
          cacheTools: false,
          cacheTrajectory: false,
        },
      },
    } as never);

    const call = generateText.mock.calls[0][0] as WireCall;
    expect(call.tools?.READ?.providerOptions).toBeUndefined();
    for (const message of call.messages ?? []) {
      for (const part of (message.content ?? []) as WirePart[]) {
        expect(part?.providerOptions).toBeUndefined();
      }
    }
    // Only the system breakpoint remains.
    expect(countCacheControls(call)).toBe(1);
    // The local flags must not leak onto the wire providerOptions.
    const wireCall = generateText.mock.calls[0][0] as { providerOptions?: unknown };
    expect(JSON.stringify(wireCall.providerOptions ?? {})).not.toContain("cacheTools");
    expect(JSON.stringify(wireCall.providerOptions ?? {})).not.toContain("cacheTrajectory");
  }, 60_000);

  it("applies the 1h runtime TTL to the tools and trajectory breakpoints", async () => {
    const generateText = mockAiSdk();
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
    } as IAgentRuntime;
    const { handleActionPlanner } = await import("../models/text");

    const tools = { READ: { description: "Read", inputSchema: { type: "object" } } };
    await handleActionPlanner(runtime1h, {
      prompt: "ignored when messages provided",
      messages: TRAJECTORY_MESSAGES,
      tools,
    } as never);

    const call = generateText.mock.calls[0][0] as WireCall;
    expect(call.tools?.READ?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
    const lastToolParts = call.messages?.[4]?.content as WirePart[];
    expect(lastToolParts[0]?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
  }, 60_000);

  it("never exceeds four breakpoints across configurations", async () => {
    const generateText = mockAiSdk();
    const { handleTextSmall, handleActionPlanner } = await import("../models/text");
    const tools = {
      A: { description: "A", inputSchema: { type: "object" } },
      B: { description: "B", inputSchema: { type: "object" } },
    };
    const manyStableSegments = Array.from({ length: 8 }, (_, index) => ({
      content: `s${index}`,
      stable: index % 2 === 0,
    }));

    // Config matrix: {tools present/absent} x {segments many/none} x
    // {trajectory present/absent}.
    await handleTextSmall(createRuntime(), {
      prompt: manyStableSegments.map((segment) => segment.content).join(""),
      promptSegments: manyStableSegments,
      tools,
    } as never);
    await handleTextSmall(createRuntime(), {
      prompt: manyStableSegments.map((segment) => segment.content).join(""),
      promptSegments: manyStableSegments,
    } as never);
    await handleTextSmall(createRuntime(), { prompt: "plain" } as never);
    await handleActionPlanner(createRuntime(), {
      prompt: "ignored",
      messages: TRAJECTORY_MESSAGES,
      tools,
    } as never);
    await handleActionPlanner(createRuntime(), {
      prompt: "ignored",
      messages: TRAJECTORY_MESSAGES,
      promptSegments: [
        { content: "stable prefix", stable: true },
        { content: "dynamic context", stable: false },
      ],
      tools,
    } as never);

    for (const [index, callArgs] of generateText.mock.calls.entries()) {
      const call = callArgs[0] as WireCall;
      expect(
        countCacheControls(call),
        `config #${index} exceeded the 4-breakpoint budget`
      ).toBeLessThanOrEqual(4);
    }
  }, 60_000);

  it("propagates AI SDK v6 cache read/write counts into the MODEL_USED event", async () => {
    const generateText = vi.fn(async () => ({
      text: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: 100,
        outputTokens: 4,
        totalTokens: 104,
        inputTokenDetails: {
          noCacheTokens: 20,
          cacheReadTokens: 80,
          cacheWriteTokens: 20,
        },
      },
      providerMetadata: { anthropic: { cacheCreationInputTokens: 20 } },
    }));
    vi.doMock("ai", () => ({ generateText, streamText: vi.fn() }));
    vi.doMock("../providers/anthropic", () => ({
      createAnthropicClientWithTopPSupport: () => (modelName: string) => ({
        modelId: modelName,
      }),
    }));

    const runtime = createRuntime();
    const { handleTextSmall } = await import("../models/text");
    const tools = { lookup: { description: "Lookup", inputSchema: { type: "object" } } };
    await handleTextSmall(runtime, { prompt: "hello", tools } as never);

    // Regression: the raw v6 usage object carries cache counts only on
    // inputTokenDetails/providerMetadata; emitting it unnormalized dropped
    // cacheRead/cacheWrite from MODEL_USED entirely.
    const emitEvent = runtime.emitEvent as ReturnType<typeof vi.fn>;
    expect(emitEvent).toHaveBeenCalledTimes(1);
    const payload = emitEvent.mock.calls[0][1] as {
      tokens: Record<string, unknown>;
    };
    expect(payload.tokens).toMatchObject({
      prompt: 100,
      completion: 4,
      total: 104,
      cacheRead: 80,
      cacheWrite: 20,
    });
  }, 60_000);
});
