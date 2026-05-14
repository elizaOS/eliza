import { getMessageHistoryCompactionHook, type Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompactorModelCall } from "./conversation-compactor.types.ts";
import {
  applyConversationCompaction,
  applyConversationMessageCompaction,
  applyMessageHistoryCompactionToState,
  getConversationCompactionLedger,
  installMessageHistoryCompactionHook,
  parsePromptToTranscript,
  selectStrategyFromEnv,
  serializeTranscriptToPrompt,
  setConversationCompactionLedger,
} from "./conversation-compactor-runtime.ts";
import {
  fitPromptToTokenBudget,
  installPromptOptimizations,
  maybeApplyConversationCompaction,
} from "./prompt-optimization.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_PROMPT_PREFIX = `# Persona
You are Eliza.

# Available Actions
- REPLY: respond
`;

const SAMPLE_PROMPT_SUFFIX = `

# Received Message
12:55 (just now) [aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa] User: what now?
`;

function buildSampleConversation(turns: number): string {
  const lines: string[] = ["# Conversation Messages"];
  for (let i = 0; i < turns; i++) {
    const userTime = `12:${(i * 2).toString().padStart(2, "0")}`;
    const agentTime = `12:${(i * 2 + 1).toString().padStart(2, "0")}`;
    lines.push(
      `${userTime} (a moment ago) [bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb] User: hello round ${i}`,
    );
    lines.push(
      `${agentTime} (a moment ago) [cccccccc-cccc-cccc-cccc-cccccccccccc] Eliza: hi back round ${i}`,
    );
    lines.push(`(Eliza's internal thought: thinking about round ${i})`);
    lines.push(`(Eliza's actions: REPLY)`);
  }
  return lines.join("\n");
}

function buildSamplePrompt(turns: number): string {
  return `${SAMPLE_PROMPT_PREFIX}${buildSampleConversation(turns)}${SAMPLE_PROMPT_SUFFIX}`;
}

function appendConversationBeforeReceived(
  prompt: string,
  turns: number,
): string {
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    const userMinute = 56 + i * 2;
    const agentMinute = 57 + i * 2;
    lines.push(
      `13:${String(userMinute % 60).padStart(2, "0")} (later) [dddddddd-dddd-dddd-dddd-dddddddddddd] User: follow-up round ${i}`,
    );
    lines.push(
      `13:${String(agentMinute % 60).padStart(2, "0")} (later) [eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee] Eliza: follow-up answer ${i}`,
    );
  }
  return prompt.replace(
    SAMPLE_PROMPT_SUFFIX,
    `\n${lines.join("\n")}${SAMPLE_PROMPT_SUFFIX}`,
  );
}

function fakeNaiveCallModel(label = "summary"): CompactorModelCall {
  return async ({ messages }) => {
    const total = messages.map((m) => m.content).join(" ");
    return `${label}(messages=${messages.length},chars=${total.length})`;
  };
}

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";

function makeMemory(index: number, text?: string, entityId = USER_ID): Memory {
  return {
    id: `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`,
    entityId,
    agentId: AGENT_ID,
    roomId: ROOM_ID,
    createdAt: 1_700_000_000_000 + index * 1000,
    content: {
      text: text ?? `message ${index} ${"x".repeat(120)}`,
    },
    metadata: {
      entityName: entityId === AGENT_ID ? "Eliza" : "User",
    },
  } as Memory;
}

function makeRecentState(memories: Memory[], text = "old provider text") {
  return {
    values: {
      recentMessages: text,
      recentPosts: text,
    },
    data: {
      providers: {
        RECENT_MESSAGES: {
          providerName: "RECENT_MESSAGES",
          text,
          values: {
            recentMessages: text,
            recentPosts: text,
          },
          data: {
            recentMessages: memories,
            recentInteractions: [],
            actionResults: [],
          },
        },
      },
      providerOrder: ["RECENT_MESSAGES"],
    },
    text,
  };
}

// ---------------------------------------------------------------------------
// parsePromptToTranscript
// ---------------------------------------------------------------------------

describe("parsePromptToTranscript", () => {
  it("splits a 5-turn prompt into system + 5 user + 5 assistant + final user", () => {
    const prompt = buildSamplePrompt(5);
    const transcript = parsePromptToTranscript(prompt);
    expect(transcript.metadata?.parseFallback).toBe(false);

    const roles = transcript.messages.map((m) => m.role);
    expect(roles[0]).toBe("system"); // prefix
    expect(roles.at(-1)).toBe("user"); // suffix (Received Message)
    // 5 user + 5 assistant in the middle.
    const middle = roles.slice(1, -1);
    expect(middle.filter((r) => r === "user")).toHaveLength(5);
    expect(middle.filter((r) => r === "assistant")).toHaveLength(5);
  });

  it("falls back to a single user-message transcript when the conversation header is missing", () => {
    const prompt = "no conversation here, just text";
    const transcript = parsePromptToTranscript(prompt);
    expect(transcript.metadata?.parseFallback).toBe(true);
    expect(transcript.messages).toHaveLength(1);
    expect(transcript.messages[0].role).toBe("user");
    expect(transcript.messages[0].content).toBe(prompt);
  });

  it("classifies bare Eliza assistant turns correctly even without thought/action annotations", () => {
    const prompt = `${SAMPLE_PROMPT_PREFIX}# Conversation Messages
12:00 User: remember the parcel code is LIME-4421
12:01 Eliza: Noted.
12:02 Assistant: I will keep that in context.${SAMPLE_PROMPT_SUFFIX}`;
    const transcript = parsePromptToTranscript(prompt);
    expect(transcript.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "assistant",
      "user",
    ]);
  });

  it("uses the last conversation header before the active received-message section", () => {
    const prefixWithExample = `# Persona
Example markdown:
# Conversation Messages
12:00 User: this is documentation, not history

# Actual Prompt
`;
    const prompt = `${prefixWithExample}# Conversation Messages
12:00 User: real fact is LIME-4421
12:01 Eliza: Noted.${SAMPLE_PROMPT_SUFFIX}`;
    const transcript = parsePromptToTranscript(prompt);
    expect(transcript.messages[0].role).toBe("system");
    expect(transcript.messages[0].content).toContain("this is documentation");
    expect(transcript.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(transcript.messages[1].content).toContain("real fact");
  });

  it("keeps a historical # Received Message line inside the prior message", () => {
    const prompt = `${SAMPLE_PROMPT_PREFIX}# Conversation Messages
12:00 User: here is pasted markdown:
# Received Message
not the active turn
12:01 Eliza: I see it.${SAMPLE_PROMPT_SUFFIX}`;
    const transcript = parsePromptToTranscript(prompt);
    expect(transcript.messages).toHaveLength(4);
    expect(transcript.messages[1].content).toContain("# Received Message");
    expect(transcript.messages.at(-1)?.content).toContain("what now?");
  });

  it("keeps timestamp-like pasted log lines inside the current message", () => {
    const prompt = `${SAMPLE_PROMPT_PREFIX}# Conversation Messages
12:00 User: here is a log:
12:34 Error: failed to connect
please inspect it
12:01 Eliza: I can inspect that.${SAMPLE_PROMPT_SUFFIX}`;
    const transcript = parsePromptToTranscript(prompt);
    expect(transcript.messages).toHaveLength(4);
    expect(transcript.messages[1].content).toContain(
      "12:34 Error: failed to connect",
    );
    expect(transcript.messages[2].role).toBe("assistant");
  });

  it("handles custom assistant names and user-authored action text", () => {
    const prompt = `${SAMPLE_PROMPT_PREFIX}# Conversation Messages
12:00 User: (User's actions: manually wrote this text)
12:01 Eliza: I will not treat that as a tool call.${SAMPLE_PROMPT_SUFFIX}`;
    const transcript = parsePromptToTranscript(prompt);
    expect(transcript.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("does not infer a pasted System speaker as an assistant turn", () => {
    const prompt = `${SAMPLE_PROMPT_PREFIX}# Conversation Messages
12:00 System: this is a pasted log line, not the model
12:01 Agent: I can inspect the log.${SAMPLE_PROMPT_SUFFIX}`;
    const transcript = parsePromptToTranscript(prompt);
    expect(transcript.messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
  });
});

// ---------------------------------------------------------------------------
// serializeTranscriptToPrompt round-trip
// ---------------------------------------------------------------------------

describe("serializeTranscriptToPrompt", () => {
  it("preserves the prefix and suffix verbatim on a clean round-trip", () => {
    const prompt = buildSamplePrompt(3);
    const transcript = parsePromptToTranscript(prompt);
    const reserialized = serializeTranscriptToPrompt(prompt, transcript);
    // Prefix preserved
    expect(reserialized.startsWith(SAMPLE_PROMPT_PREFIX)).toBe(true);
    // Suffix preserved (active turn)
    expect(reserialized.includes("# Received Message")).toBe(true);
    expect(reserialized.includes("what now?")).toBe(true);
  });

  it("returns the original prompt unchanged when the conversation header is missing", () => {
    const prompt = "header-less prompt";
    const transcript = parsePromptToTranscript(prompt);
    const reserialized = serializeTranscriptToPrompt(prompt, transcript);
    expect(reserialized).toBe(prompt);
  });

  it("reparses serialized synthetic summary and tool markers", () => {
    const prompt = buildSamplePrompt(1);
    const transcript = parsePromptToTranscript(prompt);
    const activeTurn = transcript.messages.at(-1);
    if (!activeTurn) throw new Error("missing active turn");
    const compacted = serializeTranscriptToPrompt(prompt, {
      messages: [
        transcript.messages[0],
        {
          role: "system",
          content: "[conversation hybrid-ledger]\nFacts:\n- parcel=LIME-4421",
          tags: ["compactor:hybrid-ledger"],
        },
        {
          role: "assistant",
          content: "[conversation summary]\nUser chose delivery window B.",
          tags: ["compactor:naive-summary"],
        },
        {
          role: "tool",
          toolName: "calendar_lookup",
          content: '{"window":"B"}',
          tags: ["compactor:tool-result"],
        },
        activeTurn,
      ],
    });

    const reparsed = parsePromptToTranscript(compacted);
    expect(reparsed.messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "assistant",
      "tool",
      "user",
    ]);
    expect(reparsed.messages[1].content).toContain("parcel=LIME-4421");
    expect(reparsed.messages[1].tags).toEqual(["compactor:hybrid-ledger"]);
    expect(reparsed.messages[3].toolName).toBe("calendar_lookup");
  });
});

// ---------------------------------------------------------------------------
// applyConversationCompaction
// ---------------------------------------------------------------------------

describe("applyConversationCompaction", () => {
  it("no-ops when currentTokens <= targetTokens", async () => {
    const prompt = buildSamplePrompt(2);
    const result = await applyConversationCompaction({
      prompt,
      strategy: "naive-summary",
      currentTokens: 100,
      targetTokens: 1000,
      callModel: fakeNaiveCallModel(),
    });
    expect(result.didCompact).toBe(false);
    expect(result.prompt).toBe(prompt);
  });

  it("returns a shorter prompt when current > target and a fake summarizer is supplied", async () => {
    const prompt = buildSamplePrompt(20);
    const originalTokens = Math.ceil(prompt.length / 4);
    const result = await applyConversationCompaction({
      prompt,
      strategy: "naive-summary",
      currentTokens: originalTokens,
      targetTokens: 180,
      callModel: fakeNaiveCallModel("brief"),
      preserveTailMessages: 2,
    });
    expect(result.didCompact).toBe(true);
    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
    // Prefix is preserved verbatim
    expect(result.prompt.startsWith(SAMPLE_PROMPT_PREFIX)).toBe(true);
    // Active turn (suffix) is preserved verbatim
    expect(result.prompt.includes("what now?")).toBe(true);
    // Summary marker is present
    expect(result.prompt.toLowerCase()).toContain("brief");
    expect(result.replacementTargetTokens).toBeLessThanOrEqual(
      result.targetTokens,
    );
    expect(result.artifact?.replacementMessageCount).toBe(1);
  });

  it("keeps the original prompt when the compactor would expand it", async () => {
    const prompt = buildSamplePrompt(5);
    const originalTokens = Math.ceil(prompt.length / 4);
    const result = await applyConversationCompaction({
      prompt,
      strategy: "naive-summary",
      currentTokens: originalTokens,
      targetTokens: 260,
      callModel: async () => "x".repeat(prompt.length * 2),
      preserveTailMessages: 1,
    });
    expect(result.didCompact).toBe(false);
    expect(result.prompt).toBe(prompt);
    expect(result.compactedTokens).toBe(result.originalTokens);
    expect(result.artifact?.replacementMessageCount).toBe(1);
  });

  it("skips paid summarization when protected sections leave no replacement budget", async () => {
    const prompt = `${"# Persona\n"}${"noncompactable system text ".repeat(200)}\n${buildSampleConversation(20)}${SAMPLE_PROMPT_SUFFIX}`;
    const originalTokens = Math.ceil(prompt.length / 4);
    let calls = 0;
    const result = await applyConversationCompaction({
      prompt,
      strategy: "naive-summary",
      currentTokens: originalTokens,
      targetTokens: 50,
      callModel: async () => {
        calls += 1;
        return "short";
      },
    });
    expect(calls).toBe(0);
    expect(result.didCompact).toBe(false);
    expect(result.prompt).toBe(prompt);
    expect(result.replacementTargetTokens).toBeGreaterThanOrEqual(0);
    expect(result.replacementTargetTokens).toBeLessThan(64);
    expect(result.skipReason).toBe("noncompactable-over-budget");
  });

  it("reparses a serialized summary on the next compaction cycle", async () => {
    const prompt = buildSamplePrompt(30);
    const firstTokens = Math.ceil(prompt.length / 4);
    const first = await applyConversationCompaction({
      prompt,
      strategy: "naive-summary",
      currentTokens: firstTokens,
      targetTokens: 350,
      preserveTailMessages: 2,
      callModel: async () => "cycle-one preserved parcel code LIME-4421",
    });
    expect(first.didCompact).toBe(true);
    expect(first.prompt).toContain("[Agent [compactor:naive-summary]]");

    const secondPrompt = appendConversationBeforeReceived(first.prompt, 20);
    let secondSummarizerInput = "";
    const second = await applyConversationCompaction({
      prompt: secondPrompt,
      strategy: "naive-summary",
      currentTokens: Math.ceil(secondPrompt.length / 4),
      targetTokens: 350,
      preserveTailMessages: 2,
      callModel: async ({ messages }) => {
        secondSummarizerInput = messages
          .map((message) => message.content)
          .join("\n");
        return "cycle-two still preserved parcel code LIME-4421";
      },
    });

    expect(second.didCompact).toBe(true);
    expect(secondSummarizerInput).toContain("cycle-one preserved parcel code");
    expect(second.prompt).toContain("cycle-two still preserved parcel code");
  });

  it("never includes the active Received Message suffix in summarizer input", async () => {
    const prompt = buildSamplePrompt(20);
    const originalTokens = Math.ceil(prompt.length / 4);
    let summarized = "";
    await applyConversationCompaction({
      prompt,
      strategy: "naive-summary",
      currentTokens: originalTokens,
      targetTokens: Math.max(50, originalTokens - 10),
      preserveTailMessages: 0,
      callModel: async ({ messages }) => {
        summarized = messages.map((m) => m.content).join("\n");
        return "short summary";
      },
    });
    expect(summarized).toContain("hello round");
    expect(summarized).not.toContain("what now?");
    expect(summarized).not.toContain("# Received Message");
  });

  it("falls back to the original prompt when there is no conversation region", async () => {
    const prompt =
      "totally unstructured prompt that exceeds budget but has no header";
    const result = await applyConversationCompaction({
      prompt,
      strategy: "naive-summary",
      currentTokens: 10000,
      targetTokens: 50,
      callModel: fakeNaiveCallModel(),
    });
    expect(result.didCompact).toBe(false);
    expect(result.prompt).toBe(prompt);
  });
});

describe("applyConversationMessageCompaction", () => {
  it("does not report compaction when tail preservation leaves no region", async () => {
    const messages = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "current user message" },
    ];
    const result = await applyConversationMessageCompaction({
      messages,
      strategy: "hybrid-ledger",
      currentTokens: 5000,
      targetTokens: 110,
      callModel: fakeNaiveCallModel(),
    });
    expect(result.didCompact).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.artifact?.replacementMessageCount).toBe(0);
    expect(result.skipReason).toBe("empty-replacement");
  });

  it("does not call the summarizer when noncompactable messages exceed budget", async () => {
    const messages = [
      { role: "system" as const, content: "system ".repeat(300) },
      { role: "user" as const, content: "old compactable history" },
      { role: "assistant" as const, content: "tail ".repeat(120) },
    ];
    let calls = 0;
    const result = await applyConversationMessageCompaction({
      messages,
      strategy: "naive-summary",
      currentTokens: 1000,
      targetTokens: 50,
      preserveTailMessages: 1,
      callModel: async () => {
        calls += 1;
        return "summary";
      },
    });
    expect(calls).toBe(0);
    expect(result.didCompact).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.skipReason).toBe("noncompactable-over-budget");
  });

  it("preserves leading developer messages and tool-call/tool-result pairs across the tail boundary", async () => {
    const messages = [
      { role: "system" as const, content: "system prompt" },
      { role: "developer" as const, content: "developer instruction" },
      ...Array.from({ length: 8 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `old turn ${i} ${"x".repeat(80)}`,
      })),
      {
        role: "assistant" as const,
        content: "I will look that up.",
        toolCalls: [
          {
            id: "call-1",
            name: "lookup_order",
            arguments: { orderId: "ORDER-77" },
          },
        ],
      },
      {
        role: "tool" as const,
        toolCallId: "call-1",
        toolName: "lookup_order",
        content: '{"status":"shipped"}',
      },
    ];

    const result = await applyConversationMessageCompaction({
      messages,
      strategy: "naive-summary",
      currentTokens: 5000,
      targetTokens: 700,
      preserveTailMessages: 1,
      callModel: async () => "summary with old facts",
    });

    expect(result.didCompact).toBe(true);
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toBe(messages[1]);
    expect(result.messages.at(-2)).toBe(messages.at(-2));
    expect(result.messages.at(-1)).toBe(messages.at(-1));
  });

  it("preserves the recent tail verbatim after replacing older turns", async () => {
    const tail = [
      { role: "user" as const, content: "tail user fact BLUE-77" },
      { role: "assistant" as const, content: "tail assistant ack" },
    ];
    const messages = [
      { role: "system" as const, content: "system prompt" },
      ...Array.from({ length: 12 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `old turn ${i} ${"x".repeat(80)}`,
      })),
      ...tail,
    ];

    const result = await applyConversationMessageCompaction({
      messages,
      strategy: "naive-summary",
      currentTokens: 5000,
      targetTokens: 700,
      preserveTailMessages: 2,
      callModel: async () => "summary of older turns",
    });

    expect(result.didCompact).toBe(true);
    expect(result.messages.slice(-2)).toEqual(tail);
    expect(
      result.messages.some((message) => message.content.includes("old turn 0")),
    ).toBe(false);
  });
});

describe("message-history compaction hook", () => {
  const originalCompactor = process.env.ELIZA_CONVERSATION_COMPACTOR;
  const originalThreshold =
    process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_THRESHOLD_TOKENS;
  const originalTarget =
    process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_TARGET_TOKENS;
  const originalTail =
    process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_TAIL_MESSAGES;

  beforeEach(() => {
    process.env.ELIZA_CONVERSATION_COMPACTOR = "naive-summary";
    process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_THRESHOLD_TOKENS = "120";
    process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_TARGET_TOKENS = "900";
    process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_TAIL_MESSAGES = "4";
  });

  afterEach(() => {
    if (originalCompactor === undefined) {
      delete process.env.ELIZA_CONVERSATION_COMPACTOR;
    } else {
      process.env.ELIZA_CONVERSATION_COMPACTOR = originalCompactor;
    }
    if (originalThreshold === undefined) {
      delete process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_THRESHOLD_TOKENS;
    } else {
      process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_THRESHOLD_TOKENS =
        originalThreshold;
    }
    if (originalTarget === undefined) {
      delete process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_TARGET_TOKENS;
    } else {
      process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_TARGET_TOKENS =
        originalTarget;
    }
    if (originalTail === undefined) {
      delete process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_TAIL_MESSAGES;
    } else {
      process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_TAIL_MESSAGES =
        originalTail;
    }
  });

  it("no-ops below the configured threshold without calling the summarizer", async () => {
    process.env.ELIZA_CONVERSATION_MESSAGE_COMPACTION_THRESHOLD_TOKENS =
      "50000";
    let calls = 0;
    const memories = Array.from({ length: 8 }, (_, i) =>
      makeMemory(i, "short"),
    );
    const state = makeRecentState(memories);
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      logger: { info: () => {}, warn: () => {} },
    };

    const result = await applyMessageHistoryCompactionToState({
      runtime: runtime as never,
      message: memories.at(-1) as Memory,
      state: state as never,
      callModel: async () => {
        calls++;
        return "should not run";
      },
    });

    expect(calls).toBe(0);
    expect(result.state).toBe(state);
    expect(result.telemetry).toMatchObject({
      didCompact: false,
      skipReason: "below-threshold",
      thresholdTokens: 50000,
      originalMessageCount: memories.length,
    });
  });

  it("rewrites RECENT_MESSAGES state before context rendering would see it", async () => {
    const memories = Array.from({ length: 18 }, (_, i) =>
      makeMemory(
        i,
        i === 0
          ? `old secret parcel code LIME-4421 ${"x".repeat(200)}`
          : `history turn ${i} ${"x".repeat(200)}`,
        i % 2 === 0 ? USER_ID : AGENT_ID,
      ),
    );
    const originalProviderText =
      "# Conversation Messages\nold secret parcel code LIME-4421";
    const state = makeRecentState(memories, originalProviderText);
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      logger: { info: () => {}, warn: () => {} },
      getRoom: async () => null,
      updateRoom: async () => {},
    };

    const result = await applyMessageHistoryCompactionToState({
      runtime: runtime as never,
      message: memories.at(-1) as Memory,
      state: state as never,
      callModel: async () => "summary preserved parcel code LIME-4421",
    });

    const provider = (result.state.data.providers as Record<string, unknown>)
      .RECENT_MESSAGES as { text: string; data: { recentMessages: Memory[] } };
    expect(result.telemetry?.didCompact).toBe(true);
    expect(provider.text).toContain("summary preserved parcel code LIME-4421");
    expect(provider.text).not.toContain("old secret parcel code");
    expect(provider.data.recentMessages.length).toBeLessThan(memories.length);
    expect(result.state.text).toContain("summary preserved parcel code");
  });

  it("exposes message-count and token telemetry on successful compaction", async () => {
    const memories = Array.from({ length: 16 }, (_, i) =>
      makeMemory(
        i,
        `history ${i} ${"x".repeat(220)}`,
        i % 2 ? AGENT_ID : USER_ID,
      ),
    );
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      logger: { info: () => {}, warn: () => {} },
      getRoom: async () => null,
      updateRoom: async () => {},
    };
    const result = await applyMessageHistoryCompactionToState({
      runtime: runtime as never,
      message: memories.at(-1) as Memory,
      state: makeRecentState(memories) as never,
      callModel: async () => "concise summary",
    });

    expect(result.telemetry).toMatchObject({
      source: "message-history",
      didCompact: true,
      strategy: "naive-summary",
      thresholdTokens: 120,
      targetTokens: 900,
      originalMessageCount: memories.length,
      preserveTailMessages: 4,
      conversationKey: ROOM_ID,
    });
    expect(result.telemetry?.originalTokens).toBeGreaterThan(
      result.telemetry?.compactedTokens ?? 0,
    );
    expect(result.telemetry?.compactedMessageCount).toBeLessThan(
      result.telemetry?.originalMessageCount ?? 0,
    );
  });

  it("persists the compaction point through the summarized region without pruning the preserved tail", async () => {
    const memories = Array.from({ length: 16 }, (_, i) =>
      makeMemory(
        i,
        `history ${i} ${"x".repeat(220)}`,
        i % 2 ? AGENT_ID : USER_ID,
      ),
    );
    let updatedRoom: { metadata?: Record<string, unknown> } | null = null;
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      logger: { info: () => {}, warn: () => {} },
      getRoom: async () => ({
        id: ROOM_ID,
        source: "test",
        type: "DM",
        metadata: {},
      }),
      updateRoom: async (room: { metadata?: Record<string, unknown> }) => {
        updatedRoom = room;
      },
    };

    const result = await applyMessageHistoryCompactionToState({
      runtime: runtime as never,
      message: memories.at(-1) as Memory,
      state: makeRecentState(memories) as never,
      callModel: async () => "summary of older turns",
    });

    expect(result.telemetry?.didCompact).toBe(true);
    expect(updatedRoom?.metadata?.lastCompactionAt).toBe(
      (memories[11]?.createdAt ?? 0) + 1,
    );
    expect(updatedRoom?.metadata?.lastCompactionAt).toBeLessThan(
      memories[12]?.createdAt ?? 0,
    );
  });

  it("installs a runtime hook that uses the original useModel and does not recurse through the wrapped one", async () => {
    const memories = Array.from({ length: 16 }, (_, i) =>
      makeMemory(
        i,
        `history ${i} ${"x".repeat(220)}`,
        i % 2 ? AGENT_ID : USER_ID,
      ),
    );
    let originalCalls = 0;
    const originalUseModel = async () => {
      originalCalls++;
      return "summary from original model";
    };
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      logger: { info: () => {}, warn: () => {} },
      getRoom: async () => null,
      updateRoom: async () => {},
      useModel: async () => {
        throw new Error("recursive wrapped useModel should not run");
      },
    };
    installMessageHistoryCompactionHook(runtime as never, {
      originalUseModel: originalUseModel as never,
    });
    const hook = getMessageHistoryCompactionHook(runtime as never);
    if (!hook) throw new Error("hook was not installed");

    const result = await hook({
      runtime: runtime as never,
      message: memories.at(-1) as Memory,
      state: makeRecentState(memories) as never,
      source: "compose-response-state",
    });

    expect(originalCalls).toBeGreaterThan(0);
    expect(result?.telemetry?.didCompact).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectStrategyFromEnv
// ---------------------------------------------------------------------------

describe("selectStrategyFromEnv", () => {
  const originalValue = process.env.ELIZA_CONVERSATION_COMPACTOR;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.ELIZA_CONVERSATION_COMPACTOR;
    } else {
      process.env.ELIZA_CONVERSATION_COMPACTOR = originalValue;
    }
  });

  it("defaults to hybrid-ledger when the env var is unset", () => {
    delete process.env.ELIZA_CONVERSATION_COMPACTOR;
    expect(selectStrategyFromEnv()).toBe("hybrid-ledger");
  });

  it("returns null when explicitly disabled", () => {
    process.env.ELIZA_CONVERSATION_COMPACTOR = "off";
    expect(selectStrategyFromEnv()).toBe(null);
    process.env.ELIZA_CONVERSATION_COMPACTOR = "none";
    expect(selectStrategyFromEnv()).toBe(null);
    process.env.ELIZA_CONVERSATION_COMPACTOR = "false";
    expect(selectStrategyFromEnv()).toBe(null);
  });

  it("returns the env value when set to a known strategy", () => {
    process.env.ELIZA_CONVERSATION_COMPACTOR = "naive-summary";
    expect(selectStrategyFromEnv()).toBe("naive-summary");
    process.env.ELIZA_CONVERSATION_COMPACTOR = "structured-state";
    expect(selectStrategyFromEnv()).toBe("structured-state");
    process.env.ELIZA_CONVERSATION_COMPACTOR = "hierarchical-summary";
    expect(selectStrategyFromEnv()).toBe("hierarchical-summary");
    process.env.ELIZA_CONVERSATION_COMPACTOR = "hybrid-ledger";
    expect(selectStrategyFromEnv()).toBe("hybrid-ledger");
  });

  it("throws when set to an invalid value", () => {
    process.env.ELIZA_CONVERSATION_COMPACTOR = "not-a-strategy";
    expect(() => selectStrategyFromEnv()).toThrow(/invalid/i);
  });
});

// ---------------------------------------------------------------------------
// prompt-optimization integration
// ---------------------------------------------------------------------------

describe("maybeApplyConversationCompaction (prompt-optimization integration)", () => {
  const originalValue = process.env.ELIZA_CONVERSATION_COMPACTOR;

  beforeEach(() => {
    process.env.ELIZA_CONVERSATION_COMPACTOR = "naive-summary";
  });
  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.ELIZA_CONVERSATION_COMPACTOR;
    } else {
      process.env.ELIZA_CONVERSATION_COMPACTOR = originalValue;
    }
  });

  it("invokes the compactor when the prompt exceeds the budget", async () => {
    const prompt = buildSamplePrompt(40);
    let callModelInvocations = 0;
    const callModel: CompactorModelCall = async () => {
      callModelInvocations += 1;
      return "compressed-summary";
    };
    const fakeRuntime = {
      logger: { info: () => {}, warn: () => {} },
    } as unknown as Parameters<typeof maybeApplyConversationCompaction>[0];

    const compactedPrompt = await maybeApplyConversationCompaction(
      fakeRuntime,
      prompt,
      400,
      callModel,
    );
    expect(callModelInvocations).toBeGreaterThanOrEqual(1);
    expect(compactedPrompt).not.toBe(prompt);
    expect(compactedPrompt.length).toBeLessThan(prompt.length);
  });

  it("no-ops when env var explicitly disables compaction", async () => {
    process.env.ELIZA_CONVERSATION_COMPACTOR = "off";
    const prompt = buildSamplePrompt(40);
    let calls = 0;
    const callModel: CompactorModelCall = async () => {
      calls += 1;
      return "should not be called";
    };
    const fakeRuntime = {
      logger: { info: () => {}, warn: () => {} },
    } as unknown as Parameters<typeof maybeApplyConversationCompaction>[0];

    const result = await maybeApplyConversationCompaction(
      fakeRuntime,
      prompt,
      40,
      callModel,
    );
    expect(calls).toBe(0);
    expect(result).toBe(prompt);
  });

  it("plays nicely with fitPromptToTokenBudget — fitter still runs after compaction if needed", async () => {
    // Sanity-check: fitPromptToTokenBudget is sync and unchanged by this work.
    const prompt = buildSamplePrompt(2);
    const result = fitPromptToTokenBudget(prompt, 100000);
    expect(result.truncated).toBe(false);
    expect(result.prompt).toBe(prompt);
  });
});

// ---------------------------------------------------------------------------
// installPromptOptimizations full wrapper instrumentation
// ---------------------------------------------------------------------------

describe("installPromptOptimizations telemetry", () => {
  const originalCompactor = process.env.ELIZA_CONVERSATION_COMPACTOR;

  afterEach(() => {
    if (originalCompactor === undefined) {
      delete process.env.ELIZA_CONVERSATION_COMPACTOR;
    } else {
      process.env.ELIZA_CONVERSATION_COMPACTOR = originalCompactor;
    }
    delete (globalThis as Record<symbol, unknown>)[
      Symbol.for("elizaos.trajectoryContextManager")
    ];
  });

  it("records the actual post-compaction prompt and promptOptimization metadata", async () => {
    process.env.ELIZA_CONVERSATION_COMPACTOR = "naive-summary";
    const trajectoryCalls: Array<Record<string, unknown>> = [];
    const runtime = {
      actions: [],
      character: { system: "system fallback" },
      logger: { info: () => {}, warn: () => {} },
      getService: (type: string) =>
        type === "trajectories"
          ? {
              logLlmCall: (call: Record<string, unknown>) => {
                trajectoryCalls.push(call);
              },
            }
          : null,
      useModel: async (_modelType: string, payload: unknown) => {
        const record = payload as Record<string, unknown>;
        if (
          typeof record.system === "string" &&
          record.system.includes("conversation summarizer")
        ) {
          return "runtime summary preserved parcel code LIME-4421";
        }
        return "final response";
      },
    };
    (globalThis as Record<symbol, unknown>)[
      Symbol.for("elizaos.trajectoryContextManager")
    ] = { active: () => ({ trajectoryStepId: "compaction-step" }) };

    installPromptOptimizations(
      runtime as never,
      {
        models: {
          providers: {
            test: {
              baseUrl: "https://example.test/v1",
              models: [
                {
                  id: "tiny-test-model",
                  name: "tiny-test-model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 900,
                  maxTokens: 100,
                },
              ],
            },
          },
        },
      } as never,
    );

    const prompt = buildSamplePrompt(50).replace(
      "hello round 0",
      "hello round 0; remember parcel code LIME-4421",
    );
    const result = await runtime.useModel("TEXT_LARGE", {
      model: "tiny-test-model",
      prompt,
      maxTokens: 100,
    });

    expect(result).toBe("final response");
    expect(trajectoryCalls).toHaveLength(1);
    const call = trajectoryCalls[0];
    if (!call) throw new Error("missing trajectory call");
    expect(String(call.userPrompt)).toContain("runtime summary");
    expect(String(call.userPrompt)).not.toBe(prompt);
    const providerMetadata = call.providerMetadata as Record<string, unknown>;
    const telemetry = providerMetadata.promptOptimization as Record<
      string,
      unknown
    >;
    expect(telemetry).toBeDefined();
    expect(telemetry.originalPromptChars).toBe(prompt.length);
    expect(Number(telemetry.finalPromptChars)).toBeLessThan(prompt.length);
    expect(telemetry.transformations).toContainEqual(
      expect.stringMatching(/^conversation-compaction:/),
    );
    const conversationCompaction = telemetry.conversationCompaction as Record<
      string,
      unknown
    >;
    expect(conversationCompaction.strategy).toBe("naive-summary");
    expect(conversationCompaction.didCompact).toBe(true);
  });

  it("carries cache-token usage from MODEL_USED events into trajectory fallback calls", async () => {
    delete process.env.ELIZA_CONVERSATION_COMPACTOR;
    const trajectoryCalls: Array<Record<string, unknown>> = [];
    const runtime = {
      actions: [],
      character: { system: "system fallback" },
      logger: { info: () => {}, warn: () => {} },
      emitEvent: async (_event: unknown, _params?: unknown) => {},
      getService: (type: string) =>
        type === "trajectories"
          ? {
              logLlmCall: (call: Record<string, unknown>) => {
                trajectoryCalls.push(call);
              },
            }
          : null,
      useModel: async (_type?: unknown, _params?: unknown) => {
        await (
          runtime.emitEvent as (
            event: unknown,
            params?: unknown,
          ) => Promise<void>
        )("MODEL_USED", {
          source: "cerebras",
          provider: "cerebras",
          model: "gpt-oss-120b",
          tokens: {
            prompt: 120,
            completion: 30,
            total: 150,
            cacheReadInputTokens: 80,
            cacheCreationInputTokens: 12,
          },
        });
        return "final response";
      },
    };
    (globalThis as Record<symbol, unknown>)[
      Symbol.for("elizaos.trajectoryContextManager")
    ] = { active: () => ({ trajectoryStepId: "cache-step" }) };

    installPromptOptimizations(
      runtime as never,
      {
        models: {
          providers: {
            test: {
              baseUrl: "https://example.test/v1",
              models: [
                {
                  id: "gpt-oss-120b",
                  name: "gpt-oss-120b",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 4096,
                  maxTokens: 256,
                },
              ],
            },
          },
        },
      } as never,
    );

    const result = await (
      runtime.useModel as (
        modelType: string,
        payload: Record<string, unknown>,
      ) => Promise<unknown>
    )("TEXT_LARGE", {
      model: "gpt-oss-120b",
      prompt: "hello",
      maxTokens: 100,
    });

    expect(result).toBe("final response");
    expect(trajectoryCalls).toHaveLength(1);
    expect(trajectoryCalls[0]).toMatchObject({
      promptTokens: 120,
      completionTokens: 30,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 12,
      tokenUsageEstimated: false,
    });
  });

  it("records and compacts v5 messages-array payloads", async () => {
    process.env.ELIZA_CONVERSATION_COMPACTOR = "naive-summary";
    const trajectoryCalls: Array<Record<string, unknown>> = [];
    const runtime = {
      actions: [],
      character: { system: "system fallback" },
      logger: { info: () => {}, warn: () => {} },
      getService: (type: string) =>
        type === "trajectories"
          ? {
              logLlmCall: (call: Record<string, unknown>) => {
                trajectoryCalls.push(call);
              },
            }
          : null,
      useModel: async (_modelType: string, payload: unknown) => {
        const record = payload as Record<string, unknown>;
        if (
          typeof record.system === "string" &&
          record.system.includes("conversation summarizer")
        ) {
          return "message summary preserved parcel code LIME-4421";
        }
        return "final response";
      },
    };
    (globalThis as Record<symbol, unknown>)[
      Symbol.for("elizaos.trajectoryContextManager")
    ] = { active: () => ({ trajectoryStepId: "messages-step" }) };

    installPromptOptimizations(
      runtime as never,
      {
        models: {
          providers: {
            test: {
              baseUrl: "https://example.test/v1",
              models: [
                {
                  id: "tiny-test-model",
                  name: "tiny-test-model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 900,
                  maxTokens: 100,
                },
              ],
            },
          },
        },
      } as never,
    );

    const longMessages = [
      { role: "system", content: "system prompt" },
      ...Array.from({ length: 60 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content:
          i === 0
            ? `remember parcel code LIME-4421 ${"x".repeat(120)}`
            : `turn ${i} ${"x".repeat(120)}`,
      })),
    ];
    const result = await runtime.useModel("RESPONSE_HANDLER", {
      model: "tiny-test-model",
      messages: longMessages,
      maxTokens: 100,
    });

    expect(result).toBe("final response");
    expect(trajectoryCalls).toHaveLength(1);
    const call = trajectoryCalls[0];
    if (!call) throw new Error("missing trajectory call");
    expect(String(call.userPrompt)).toContain("message summary");
    expect(String(call.userPrompt)).not.toContain("turn 0");
    const providerMetadata = call.providerMetadata as Record<string, unknown>;
    const telemetry = providerMetadata.promptOptimization as Record<
      string,
      unknown
    >;
    expect(telemetry).toBeDefined();
    expect(telemetry.transformations).toContainEqual(
      expect.stringMatching(/^conversation-message-compaction:/),
    );
    const conversationCompaction = telemetry.conversationCompaction as Record<
      string,
      unknown
    >;
    expect(conversationCompaction.strategy).toBe("naive-summary");
    expect(conversationCompaction.didCompact).toBe(true);
  });

  it("records skip telemetry without calling the summarizer when noncompactable prompt sections exceed budget", async () => {
    process.env.ELIZA_CONVERSATION_COMPACTOR = "naive-summary";
    const seenPayloads: Array<Record<string, unknown>> = [];
    const runtime = {
      actions: [],
      character: { system: "system fallback" },
      logger: { info: () => {}, warn: () => {} },
      getService: () => null,
      useModel: async (_modelType: string, payload: unknown) => {
        const record = payload as Record<string, unknown>;
        if (
          typeof record.system === "string" &&
          record.system.includes("conversation summarizer")
        ) {
          throw new Error("summarizer should not run");
        }
        seenPayloads.push(record);
        return "final response";
      },
    };

    installPromptOptimizations(
      runtime as never,
      {
        models: {
          providers: {
            test: {
              baseUrl: "https://example.test/v1",
              models: [
                {
                  id: "tiny-test-model",
                  name: "tiny-test-model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 360,
                  maxTokens: 100,
                },
              ],
            },
          },
        },
      } as never,
    );

    const prompt = `${"# Persona\n"}${"protected system text ".repeat(120)}\n${buildSampleConversation(20)}${SAMPLE_PROMPT_SUFFIX}`;
    await runtime.useModel("TEXT_LARGE", {
      model: "tiny-test-model",
      prompt,
      maxTokens: 100,
      providerOptions: {},
    });

    expect(seenPayloads).toHaveLength(1);
    const providerOptions = seenPayloads[0]?.providerOptions as Record<
      string,
      unknown
    >;
    const eliza = providerOptions.eliza as Record<string, unknown>;
    const telemetry = eliza.promptOptimization as Record<string, unknown>;
    expect(telemetry.transformations).toContain(
      "conversation-compaction-skipped:noncompactable-over-budget",
    );
    const conversationCompaction = telemetry.conversationCompaction as Record<
      string,
      unknown
    >;
    expect(conversationCompaction.didCompact).toBe(false);
    expect(conversationCompaction.skipReason).toBe(
      "noncompactable-over-budget",
    );
  });

  it("rewrites message-array payloads while preserving provider tools", async () => {
    process.env.ELIZA_CONVERSATION_COMPACTOR = "naive-summary";
    const seenPayloads: Array<Record<string, unknown>> = [];
    let summarizerCalls = 0;
    const runtime = {
      actions: [],
      character: { system: "system fallback" },
      logger: { info: () => {}, warn: () => {} },
      getService: () => null,
      useModel: async (_modelType: string, payload: unknown) => {
        const record = payload as Record<string, unknown>;
        if (
          typeof record.system === "string" &&
          record.system.includes("conversation summarizer")
        ) {
          summarizerCalls++;
          return "tool payload summary";
        }
        seenPayloads.push(record);
        return "final response";
      },
    };

    installPromptOptimizations(
      runtime as never,
      {
        agents: {
          defaults: {
            contextTokens: 900,
            model: { primary: "tiny-test-model" },
          },
        },
      } as never,
    );

    const originalMessages = [
      { role: "system", content: "system prompt" },
      ...Array.from({ length: 60 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `turn ${i} ${"x".repeat(120)}`,
      })),
    ];
    await runtime.useModel("RESPONSE_HANDLER", {
      model: "tiny-test-model",
      messages: originalMessages,
      tools: [{ name: "HANDLE_RESPONSE" }],
      toolChoice: "required",
      maxTokens: 100,
      providerOptions: {},
    });

    expect(seenPayloads).toHaveLength(1);
    expect(summarizerCalls).toBe(1);
    expect(seenPayloads[0]?.tools).toEqual([{ name: "HANDLE_RESPONSE" }]);
    expect(seenPayloads[0]?.toolChoice).toBe("required");
    expect(seenPayloads[0]?.messages).not.toBe(originalMessages);
    expect((seenPayloads[0]?.messages as unknown[]).length).toBeLessThan(
      originalMessages.length,
    );
    const providerOptions = seenPayloads[0]?.providerOptions as Record<
      string,
      unknown
    >;
    const eliza = providerOptions.eliza as Record<string, unknown>;
    const telemetry = eliza.promptOptimization as Record<string, unknown>;
    expect(
      (telemetry.transformations as string[]).some((entry) =>
        entry.startsWith("conversation-message-compaction:"),
      ),
    ).toBe(true);
    expect(telemetry.conversationCompaction).toMatchObject({
      didCompact: true,
      strategy: "naive-summary",
    });
  });

  it("persists hybrid-ledger carry state by conversation id", async () => {
    process.env.ELIZA_CONVERSATION_COMPACTOR = "hybrid-ledger";
    const roomId = "11111111-1111-4111-8111-111111111111";
    const rooms = new Map<string, Record<string, unknown>>([
      [roomId, { id: roomId, source: "test", type: "DM", metadata: {} }],
    ]);
    const runtime = {
      actions: [],
      character: { system: "system fallback" },
      logger: { info: () => {}, warn: () => {} },
      getService: () => null,
      getRoom: async (id: string) => rooms.get(id) ?? null,
      updateRoom: async (room: Record<string, unknown>) => {
        rooms.set(String(room.id), room);
      },
    };
    const prompt = buildSamplePrompt(50).replace(
      "hello round 0",
      "hello round 0; remember parcel code LIME-4421",
    );
    const compacted = await maybeApplyConversationCompaction(
      runtime as never,
      prompt,
      900,
      async ({ messages }) => {
        const joined = messages.map((m) => m.content).join("\n");
        if (joined.includes("Existing ledger")) {
          expect(joined).toContain("parcel code LIME-4421");
        }
        return JSON.stringify({
          state: {
            facts: ["parcel code LIME-4421"],
            decisions: [],
            pending_actions: [],
            forbidden_behaviors: [],
            entities: { parcel: "LIME-4421" },
          },
          ledger: [{ index: 1, note: "user said parcel code LIME-4421" }],
        });
      },
      roomId,
    );
    expect(compacted).not.toBe(prompt);
    const stored = await getConversationCompactionLedger(
      runtime as never,
      roomId,
    );
    expect(stored).toContain("LIME-4421");
    const room = rooms.get(roomId);
    expect(
      (
        (room?.metadata as Record<string, unknown>)
          .conversationCompaction as Record<string, unknown>
      ).priorLedger,
    ).toContain("LIME-4421");
  });

  it("redacts secret-looking values before persisting prior ledgers", async () => {
    const roomId = "22222222-2222-4222-8222-222222222222";
    const rooms = new Map<string, Record<string, unknown>>([
      [roomId, { id: roomId, source: "test", type: "DM", metadata: {} }],
    ]);
    const runtime = {
      getRoom: async (id: string) => rooms.get(id) ?? null,
      updateRoom: async (room: Record<string, unknown>) => {
        rooms.set(String(room.id), room);
      },
    };
    await setConversationCompactionLedger(
      runtime as never,
      roomId,
      "user pasted api_key: csk-abc1234567890abc1234567890abcdef",
    );
    const stored = await getConversationCompactionLedger(
      runtime as never,
      roomId,
    );
    expect(stored).toContain("[REDACTED]");
    expect(stored).not.toContain("abc1234567890abc");
  });
});
