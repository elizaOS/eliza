/**
 * Pins Shared memory commits around the sole AgentRuntime turn boundary. A
 * landed non-stream reply commits once; failed or degraded turns never write.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SharedMemoryStore, SharedMemoryTurnPair } from "./shared-memory-store";

let providerConfigured = true;
let runtimeFailure: Error | null = null;

mock.module("../../providers/language-model", () => ({
  hasLanguageModelProviderConfigured: () => providerConfigured,
}));

mock.module("./shared-eliza-runtime", () => ({
  runSharedElizaRuntimeTurn: async (input: Record<string, unknown>) => {
    if (runtimeFailure) throw runtimeFailure;
    const history = input.history as Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }>;
    return {
      reply: "landed reply",
      history: [
        ...history,
        { role: "user" as const, content: String(input.message) },
        { role: "assistant" as const, content: "landed reply" },
      ],
      model: String(input.model),
      degraded: false,
    };
  },
  runSharedElizaRuntimeTurnStream: async (input: Record<string, unknown>) => ({
    model: String(input.model),
    degraded: false,
    parts: (async function* () {
      yield { type: "text-delta" as const, text: "landed " };
      yield { type: "text-delta" as const, text: "reply" };
      yield { type: "finish" as const, text: "landed reply" };
    })(),
  }),
}));

const { runSharedAgentTurn, runSharedAgentTurnStream } = await import("./run-shared-agent-turn");

function scriptedMemory(behavior?: { fail?: boolean }): {
  store: SharedMemoryStore;
  pairs: SharedMemoryTurnPair[];
} {
  const pairs: SharedMemoryTurnPair[] = [];
  const store = {
    async recordTurnPair(pair: SharedMemoryTurnPair) {
      if (behavior?.fail) throw new Error("scripted memory failure");
      pairs.push(pair);
    },
  } as unknown as SharedMemoryStore;
  return { store, pairs };
}

const character = { name: "Memory Pin", system: "You are a test persona." };
const messageIds = {
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  assistant: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

beforeEach(() => {
  providerConfigured = true;
  runtimeFailure = null;
});

describe("runSharedAgentTurn memory commit", () => {
  test("records the landed pair exactly once with transport ids", async () => {
    const memory = scriptedMemory();
    const result = await runSharedAgentTurn({
      character,
      history: [],
      message: "  remember this  ",
      messageIds,
      memory: memory.store,
    });
    expect(result.reply).toBe("landed reply");
    expect(memory.pairs).toEqual([
      { userMessage: "remember this", assistantReply: "landed reply", messageIds },
    ]);
  });

  test("does not write when AgentRuntime fails and preserves its cause", async () => {
    const memory = scriptedMemory();
    runtimeFailure = new Error("provider exploded");
    const error = await runSharedAgentTurn({
      character,
      history: [],
      message: "will fail",
      memory: memory.store,
    }).catch((caught) => caught as Error);
    expect(error.message).toContain("AgentRuntime turn failed");
    expect(error.cause).toBe(runtimeFailure);
    expect(memory.pairs).toEqual([]);
  });

  test("surfaces memory storage failures", async () => {
    const failing = scriptedMemory({ fail: true });
    await expect(
      runSharedAgentTurn({
        character,
        history: [],
        message: "landed but not durable",
        memory: failing.store,
      }),
    ).rejects.toThrow("scripted memory failure");
  });

  test("does not write the designed no-model degraded state", async () => {
    const memory = scriptedMemory();
    providerConfigured = false;
    const result = await runSharedAgentTurn({
      character,
      history: [],
      message: "no model configured",
      memory: memory.store,
    });
    expect(result.degraded).toBe(true);
    expect(memory.pairs).toEqual([]);
  });
});

describe("runSharedAgentTurnStream memory boundary", () => {
  test("leaves streaming commits to the consumer-aware transport finalizer", async () => {
    const turn = await runSharedAgentTurnStream({
      character,
      history: [],
      message: "stream me",
      messageIds,
    });
    if (!turn.parts) throw new Error("stream turn returned no parts");
    const seen: string[] = [];
    for await (const part of turn.parts) seen.push(part.type);
    expect(seen).toEqual(["text-delta", "text-delta", "finish"]);
  });
});
