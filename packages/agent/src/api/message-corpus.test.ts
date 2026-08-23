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
});
