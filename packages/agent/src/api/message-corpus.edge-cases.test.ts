/**
 * Runtime unit coverage for message-corpus generation and seeding edge cases.
 */

import {
  ChannelType,
  MESSAGE_SOURCE_CLIENT_CHAT,
  type Memory,
  MemoryType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  generateMessageCorpus,
  type MessageCorpusRuntime,
  seedMessageCorpus,
} from "./message-corpus.js";

const NOW = Date.UTC(2026, 7, 23, 12);
const AGENT_ID = stringToUuid("message-corpus-test-agent") as UUID;

interface RecordedMemory {
  memory: Memory;
  tableName: string;
  unique?: boolean;
}

function createRecordingRuntime(characterName?: string) {
  const connections: Array<
    Parameters<MessageCorpusRuntime["ensureConnection"]>[0]
  > = [];
  const memories: RecordedMemory[] = [];
  const runtime: MessageCorpusRuntime = {
    agentId: AGENT_ID,
    character: characterName === undefined ? {} : { name: characterName },
    ensureConnection: async (params) => {
      connections.push(params);
    },
    createMemory: async (memory, tableName, unique) => {
      memories.push({ memory, tableName, unique });
      return memory.id as UUID;
    },
  };

  return { connections, memories, runtime };
}

describe("generateMessageCorpus edge cases", () => {
  it("returns explicit empty bounds when no conversations are requested", () => {
    const corpus = generateMessageCorpus({
      conversationCount: 0,
      messagesPerConversation: 4,
      now: NOW,
      seed: 1,
    });

    expect(corpus).toEqual({
      conversations: [],
      sampleQueries: [],
      oldestMessageAt: null,
      newestMessageAt: null,
    });
  });

  it("uses the conversation start for facts and bounds when messages are absent", () => {
    const corpus = generateMessageCorpus({
      conversationCount: 1,
      messagesPerConversation: 0,
      factsPerConversation: 3,
      now: NOW,
      seed: 2,
    });
    const conversation = corpus.conversations[0];

    expect(conversation.messages).toEqual([]);
    expect(conversation.facts).toHaveLength(3);
    expect(conversation.facts.map((fact) => fact.createdAt)).toEqual([
      conversation.createdAt,
      conversation.createdAt,
      conversation.createdAt,
    ]);
    expect(conversation.facts[2]?.text).toBe(conversation.facts[0]?.text);
    expect(corpus.oldestMessageAt).toBeNull();
    expect(corpus.newestMessageAt).toBeNull();
  });

  it("cycles topics while capping distinctive sample queries", () => {
    const corpus = generateMessageCorpus({
      conversationCount: 10,
      messagesPerConversation: 3,
      now: NOW,
      seed: 3,
    });

    expect(corpus.conversations.map(({ topic }) => topic)).toEqual([
      "fitness",
      "baking",
      "infra",
      "finance",
      "travel",
      "reading",
      "garden",
      "health",
      "fitness",
      "baking",
    ]);
    expect(corpus.sampleQueries).toEqual([
      "marathon",
      "sourdough",
      "canary",
      "invoice",
      "kyoto",
      "abandoning",
      "seedlings",
      "migraine",
    ]);
    for (const conversation of corpus.conversations) {
      expect(conversation.messages.map(({ role }) => role)).toEqual([
        "user",
        "assistant",
        "user",
      ]);
      expect(conversation.messages[0]?.createdAt).toBeLessThan(
        conversation.messages[1]?.createdAt ?? 0,
      );
      expect(conversation.messages[1]?.createdAt).toBeLessThan(
        conversation.messages[2]?.createdAt ?? 0,
      );
    }
  });
});

describe("seedMessageCorpus edge cases", () => {
  it("does no runtime work for an empty corpus", async () => {
    const corpus = generateMessageCorpus({
      conversationCount: 0,
      now: NOW,
    });
    const { connections, memories, runtime } = createRecordingRuntime("Agent");

    const summary = await seedMessageCorpus(runtime, corpus);

    expect(connections).toEqual([]);
    expect(memories).toEqual([]);
    expect(summary).toEqual({
      conversations: [],
      messagesCreated: 0,
      factsCreated: 0,
      oldestMessageAt: null,
      newestMessageAt: null,
      sampleQueries: [],
    });
  });

  it("uses the default Eliza namespace and conversation time without messages", async () => {
    const corpus = generateMessageCorpus({
      conversationCount: 1,
      messagesPerConversation: 0,
      factsPerConversation: 1,
      now: NOW,
      seed: 4,
    });
    const { connections, memories, runtime } = createRecordingRuntime();

    const summary = await seedMessageCorpus(runtime, corpus);
    const connection = connections[0];

    expect(connection.worldId).toBe(stringToUuid("Eliza-web-chat-world"));
    expect(connection.messageServerId).toBe(stringToUuid("Eliza-web-server"));
    expect(connection.type).toBe(ChannelType.DM);
    expect(connection.source).toBe(MESSAGE_SOURCE_CLIENT_CHAT);
    expect(summary.conversations[0]?.lastMessageAt).toBeNull();
    expect(summary.messagesCreated).toBe(0);
    expect(summary.factsCreated).toBe(1);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.tableName).toBe("facts");
    expect(memories[0]?.unique).toBe(true);
  });

  it("persists real message and fact shapes with role-specific authors", async () => {
    const corpus = generateMessageCorpus({
      conversationCount: 1,
      messagesPerConversation: 2,
      factsPerConversation: 1,
      now: NOW,
      seed: 5,
    });
    const { connections, memories, runtime } =
      createRecordingRuntime("Corpus Agent");

    const summary = await seedMessageCorpus(runtime, corpus);
    const ownerEntityId = stringToUuid(
      `message-corpus-owner-${AGENT_ID}`,
    ) as UUID;
    const [userMessage, assistantMessage, fact] = memories;

    expect(connections[0]?.metadata).toEqual({
      ownership: { ownerId: ownerEntityId },
    });
    expect(userMessage?.tableName).toBe("messages");
    expect(userMessage?.memory.entityId).toBe(ownerEntityId);
    expect(userMessage?.memory.metadata).toEqual({ type: MemoryType.MESSAGE });
    expect(userMessage?.memory.content.source).toBe(MESSAGE_SOURCE_CLIENT_CHAT);
    expect(assistantMessage?.tableName).toBe("messages");
    expect(assistantMessage?.memory.entityId).toBe(AGENT_ID);
    expect(fact?.tableName).toBe("facts");
    expect(fact?.unique).toBe(true);
    expect(fact?.memory.metadata).toEqual({
      type: MemoryType.CUSTOM,
      source: "message-corpus-seed",
      confidence: 0.95,
      kind: "durable",
      category: "seeded",
      keywords: [],
    });
    expect(summary.messagesCreated).toBe(2);
    expect(summary.factsCreated).toBe(1);
    expect(summary.conversations[0]?.lastMessageAt).toBe(
      corpus.conversations[0]?.messages[1]?.createdAt,
    );
  });
});
