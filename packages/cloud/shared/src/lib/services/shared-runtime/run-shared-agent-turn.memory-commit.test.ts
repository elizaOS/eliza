/**
 * Pins the P2 edge-memory commit point in runSharedAgentTurn(Stream): a landed
 * user/assistant pair is durably recorded through the attached SharedMemoryStore
 * exactly once after a non-streamed reply lands. Streaming ownership stays at
 * the transport finalization boundary, which alone knows whether the consumer
 * accepted a complete reply or cancelled on an interrupted prefix. Failed
 * provider turns never write; store failures surface as storage faults, not
 * provider outcomes. The language-model router and `ai` SDK are stubbed
 * deterministically; the memory store is a scripted double.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { SharedMemoryStore, SharedMemoryTurnPair } from "./shared-memory-store";

let providerConfigured = true;
let generateTextImpl: () => Promise<{ text: string; usage?: unknown }> = async () => ({
  text: "landed reply",
});

function aiFullStream(iterable: AsyncIterable<unknown>): ReadableStream<unknown> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}

mock.module("../../providers/language-model", () => ({
  getLanguageModel: () => ({ __sentinel: "model" }),
  getInteractiveCerebrasLanguageModel: () => ({ __sentinel: "interactive-model" }),
  hasLanguageModelProviderConfigured: () => providerConfigured,
}));

mock.module("ai", () => ({
  generateText: async () => generateTextImpl(),
  streamText: () => ({
    fullStream: aiFullStream(
      (async function* () {
        yield { type: "text-delta", text: "landed " };
        yield { type: "text-delta", text: "reply" };
        yield { type: "finish", totalUsage: { totalTokens: 3 } };
      })(),
    ),
    text: Promise.resolve("landed reply"),
    totalUsage: Promise.resolve({ totalTokens: 3 }),
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
  generateTextImpl = async () => ({ text: "landed reply" });
});

describe("runSharedAgentTurn memory commit", () => {
  test("records the landed pair exactly once with the transport ids", async () => {
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
      {
        userMessage: "remember this",
        assistantReply: "landed reply",
        messageIds,
        source: "shared-runtime",
        channelType: "DM",
      },
    ]);
    expect(result.history.slice(-2)).toEqual([
      expect.objectContaining({ source: "shared-runtime", channelType: "DM" }),
      expect.objectContaining({ source: "shared-runtime", channelType: "DM" }),
    ]);
  });

  test("does not write when the provider turn fails, and the provider cause survives", async () => {
    const memory = scriptedMemory();
    generateTextImpl = async () => {
      throw new Error("provider exploded");
    };
    await expect(
      runSharedAgentTurn({
        character,
        history: [],
        message: "will fail",
        memory: memory.store,
      }),
    ).rejects.toThrow("agent turn failed");
    expect(memory.pairs).toEqual([]);
  });

  test("a memory-store failure surfaces as a storage fault, not a provider outcome", async () => {
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

  test("the designed degraded (no model) state never writes memory", async () => {
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
  test("leaves streaming memory commits to the consumer-aware transport boundary", async () => {
    const turn = await runSharedAgentTurnStream({
      character,
      history: [],
      message: "stream me",
      messageIds,
    });
    if (!turn.parts) throw new Error("stream turn returned no parts");
    const seen: string[] = [];
    for await (const part of turn.parts) {
      seen.push(part.type);
    }
    expect(seen).toEqual(["text-delta", "text-delta", "finish"]);
  });

  test("without a memory store the stream shape is unchanged and nothing writes", async () => {
    const turn = await runSharedAgentTurnStream({
      character,
      history: [],
      message: "no store attached",
    });
    if (!turn.parts) throw new Error("stream turn returned no parts");
    const types: string[] = [];
    for await (const part of turn.parts) types.push(part.type);
    expect(types).toEqual(["text-delta", "text-delta", "finish"]);
  });
});
