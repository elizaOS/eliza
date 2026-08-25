/**
 * Unit tests for deterministic backdated message corpus generation and database seeding.
 */

import type { UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  generateMessageCorpus,
  type MessageCorpusRuntime,
  seedMessageCorpus,
} from "./message-corpus.js";

describe("message-corpus", () => {
  it("generates deterministic conversations and sample queries", () => {
    const fixedNow = 1700000000000;
    const corpus1 = generateMessageCorpus({
      conversationCount: 3,
      messagesPerConversation: 4,
      seed: 42,
      now: fixedNow,
    });

    const corpus2 = generateMessageCorpus({
      conversationCount: 3,
      messagesPerConversation: 4,
      seed: 42,
      now: fixedNow,
    });

    expect(corpus1).toEqual(corpus2);
    expect(corpus1.conversations).toHaveLength(3);
    expect(corpus1.sampleQueries.length).toBeGreaterThan(0);
    if (corpus1.oldestMessageAt === null || corpus1.newestMessageAt === null) {
      throw new Error("generated messages must have timestamp bounds");
    }
    expect(corpus1.oldestMessageAt).toBeLessThan(corpus1.newestMessageAt);

    for (const conv of corpus1.conversations) {
      expect(conv.messages).toHaveLength(4);
      expect(conv.facts).toBeDefined();
      expect(conv.topic).toBeDefined();
      expect(conv.title).toBeDefined();
    }
  });

  it("seeds generated corpus into runtime messages and facts tables", async () => {
    const createdMemories: Array<{ memory: unknown; table: string }> = [];
    const mockRuntime: MessageCorpusRuntime = {
      agentId: "12345678-1234-1234-1234-123456789abc" as UUID,
      character: { name: "Eliza" },
      ensureConnection: vi.fn().mockResolvedValue(undefined),
      createMemory: vi.fn().mockImplementation(async (memory, table) => {
        createdMemories.push({ memory, table });
        return memory.id;
      }),
    };

    const corpus = generateMessageCorpus({
      conversationCount: 2,
      messagesPerConversation: 2,
      factsPerConversation: 1,
      seed: 100,
    });

    const summary = await seedMessageCorpus(mockRuntime, corpus);

    expect(summary.conversations).toHaveLength(2);
    expect(summary.messagesCreated).toBe(4);
    expect(summary.factsCreated).toBe(2);
    expect(mockRuntime.ensureConnection).toHaveBeenCalledTimes(2);

    const messageMemories = createdMemories.filter(
      (m) => m.table === "messages",
    );
    const factMemories = createdMemories.filter((m) => m.table === "facts");

    expect(messageMemories).toHaveLength(4);
    expect(factMemories).toHaveLength(2);
  });

  it("binds planted conversations to an explicit existing owner", async () => {
    const ownerEntityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
    const createdMemories: Array<{
      memory: { entityId?: UUID };
      table: string;
    }> = [];
    const mockRuntime: MessageCorpusRuntime = {
      agentId: "12345678-1234-1234-1234-123456789abc" as UUID,
      character: { name: "Eliza" },
      ensureConnection: vi.fn().mockResolvedValue(undefined),
      createMemory: vi.fn().mockImplementation(async (memory, table) => {
        createdMemories.push({ memory, table });
        return memory.id;
      }),
    };
    const corpus = generateMessageCorpus({
      conversationCount: 1,
      messagesPerConversation: 2,
      factsPerConversation: 1,
      seed: 101,
    });

    await seedMessageCorpus(mockRuntime, corpus, { ownerEntityId });

    expect(mockRuntime.ensureConnection).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: ownerEntityId }),
    );
    expect(
      createdMemories
        .filter(({ memory }) => memory.entityId !== mockRuntime.agentId)
        .every(({ memory }) => memory.entityId === ownerEntityId),
    ).toBe(true);
  });

  it("handles empty corpus shape without timestamps", () => {
    const fixedNow = 1700000000000;
    const corpus = generateMessageCorpus({
      conversationCount: 0,
      messagesPerConversation: 0,
      seed: 1,
      now: fixedNow,
    });
    expect(corpus.conversations).toHaveLength(0);
    expect(corpus.oldestMessageAt).toBeNull();
    expect(corpus.newestMessageAt).toBeNull();
    expect(corpus.sampleQueries).toHaveLength(0);
  });

  it("produces varying output across seeds and stable ordering", () => {
    const fixedNow = 1700000000000;
    const a = generateMessageCorpus({ conversationCount: 2, messagesPerConversation: 3, seed: 1, now: fixedNow });
    const b = generateMessageCorpus({ conversationCount: 2, messagesPerConversation: 3, seed: 2, now: fixedNow });
    expect(a).not.toEqual(b);
    // messages within a conversation are strictly increasing in time
    for (const conv of a.conversations) {
      for (let i = 1; i < conv.messages.length; i++) {
        expect(conv.messages[i].createdAt).toBeGreaterThan(conv.messages[i - 1].createdAt);
      }
      expect(conv.messages.filter((m) => m.role === "user")).toHaveLength(Math.ceil(conv.messages.length / 2));
      expect(conv.title).toMatch(/\(.+ \d{4}\)$/);
    }
    // sampleQueries bounded by conversationCount and pack size
    expect(a.sampleQueries.length).toBeLessThanOrEqual(a.conversations.length);
  });

  it("propagates scope and timestamps through seedSummary lifecycle", async () => {
    const fixedNow = 1700000000000;
    const corpus = generateMessageCorpus({
      conversationCount: 1,
      messagesPerConversation: 3,
      factsPerConversation: 2,
      seed: 77,
      now: fixedNow,
    });
    const mockRuntime: MessageCorpusRuntime = {
      agentId: "12345678-1234-1234-1234-123456789abc" as UUID,
      character: {},
      ensureConnection: vi.fn().mockResolvedValue(undefined),
      createMemory: vi.fn().mockResolvedValue("id" as UUID),
    };
    const summary = await seedMessageCorpus(mockRuntime, corpus);
    expect(summary.messagesCreated).toBe(3);
    expect(summary.factsCreated).toBe(2);
    expect(summary.oldestMessageAt).toBe(corpus.oldestMessageAt);
    expect(summary.newestMessageAt).toBe(corpus.newestMessageAt);
    expect(summary.sampleQueries).toEqual(corpus.sampleQueries);
    expect(summary.conversations[0].lastMessageAt).toBe(corpus.conversations[0].messages.at(-1)?.createdAt ?? null);
  });

  it("defaults to synthetic owner when no explicit owner is supplied", async () => {
    const corpus = generateMessageCorpus({ conversationCount: 1, messagesPerConversation: 1, seed: 5 });
    const ensureCalls: Array<Record<string, unknown>> = [];
    const mockRuntime: MessageCorpusRuntime = {
      agentId: "12345678-1234-1234-1234-123456789abc" as UUID,
      character: { name: "TestAgent" },
      ensureConnection: vi.fn().mockImplementation(async (params) => { ensureCalls.push(params as Record<string, unknown>); }),
      createMemory: vi.fn().mockResolvedValue("id" as UUID),
    };
    const summary = await seedMessageCorpus(mockRuntime, corpus);
    expect(ensureCalls).toHaveLength(1);
    expect(ensureCalls[0].roomName).toBe(corpus.conversations[0].title);
    expect(summary.conversations).toHaveLength(1);
  });

  it("respects spanMonths zero as immediate window", () => {
    const fixedNow = 1700000000000;
    const corpus = generateMessageCorpus({ conversationCount: 1, messagesPerConversation: 2, spanMonths: 0, seed: 9, now: fixedNow });
    expect(corpus.conversations).toHaveLength(1);
    expect(corpus.oldestMessageAt).not.toBeNull();
    expect(corpus.newestMessageAt).not.toBeNull();
    for (const msg of corpus.conversations[0].messages) {
      expect(msg.createdAt).toBeLessThanOrEqual(fixedNow);
    }
  });

});
