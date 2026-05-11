import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompactorModelCall } from "./conversation-compactor.types.ts";
import {
  applyConversationCompaction,
  applyConversationMessageCompaction,
  parsePromptToTranscript,
  selectStrategyFromEnv,
  serializeTranscriptToPrompt,
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
12:01 Milady: I will not treat that as a tool call.${SAMPLE_PROMPT_SUFFIX}`;
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
      targetTokens: 20,
      callModel: async () => "x".repeat(prompt.length * 2),
      preserveTailMessages: 1,
    });
    expect(result.didCompact).toBe(false);
    expect(result.prompt).toBe(prompt);
    expect(result.compactedTokens).toBe(result.originalTokens);
    expect(result.artifact?.replacementMessageCount).toBe(1);
  });

  it("compacts when protected sections prevent fitting the target budget", async () => {
    const prompt = buildSamplePrompt(20);
    const originalTokens = Math.ceil(prompt.length / 4);
    let calls = 0;
    const result = await applyConversationCompaction({
      prompt,
      strategy: "naive-summary",
      currentTokens: originalTokens,
      targetTokens: 8,
      callModel: async () => {
        calls += 1;
        return "short";
      },
    });
    expect(calls).toBe(1);
    expect(result.didCompact).toBe(true);
    expect(result.prompt).not.toBe(prompt);
    expect(result.compactedTokens).toBeLessThan(result.originalTokens);
    expect(result.compactedTokens).toBeGreaterThan(result.targetTokens);
    expect(result.replacementTargetTokens).toBeLessThanOrEqual(
      result.targetTokens,
    );
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
      targetTokens: 50,
      callModel: fakeNaiveCallModel(),
    });
    expect(result.didCompact).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.artifact?.replacementMessageCount).toBe(0);
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

  it("does not rewrite messages-array payloads while provider tools are present", async () => {
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
          throw new Error("summarizer should not run for tool payloads");
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
    expect(seenPayloads[0]?.messages).toBe(originalMessages);
    const providerOptions = seenPayloads[0]?.providerOptions as Record<
      string,
      unknown
    >;
    const eliza = providerOptions.eliza as Record<string, unknown>;
    const telemetry = eliza.promptOptimization as Record<string, unknown>;
    expect(telemetry.transformations).toContain(
      "conversation-message-compaction-skipped:provider-tools-present",
    );
    expect(telemetry.conversationCompaction).toBeUndefined();
  });
});
