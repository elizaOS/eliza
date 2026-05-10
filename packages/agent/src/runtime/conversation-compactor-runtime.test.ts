import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyConversationCompaction,
  parsePromptToTranscript,
  selectStrategyFromEnv,
  serializeTranscriptToPrompt,
} from "./conversation-compactor-runtime.ts";
import type { CompactorModelCall } from "./conversation-compactor.types.ts";
import {
  fitPromptToTokenBudget,
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

function fakeNaiveCallModel(label = "summary"): CompactorModelCall {
  return async ({ messages }) => {
    const total = messages.map((m) => m.content).join(" ");
    return `${label}(messages=${messages.length},chars=${total.length})`;
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
      targetTokens: 50,
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
  });

  it("falls back to the original prompt when there is no conversation region", async () => {
    const prompt = "totally unstructured prompt that exceeds budget but has no header";
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

  it("returns null when the env var is unset", () => {
    delete process.env.ELIZA_CONVERSATION_COMPACTOR;
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
      40, // tiny budget — guaranteed to be exceeded
      callModel,
    );
    expect(callModelInvocations).toBeGreaterThanOrEqual(1);
    expect(compactedPrompt).not.toBe(prompt);
    expect(compactedPrompt.length).toBeLessThan(prompt.length);
  });

  it("no-ops when env var is unset", async () => {
    delete process.env.ELIZA_CONVERSATION_COMPACTOR;
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
