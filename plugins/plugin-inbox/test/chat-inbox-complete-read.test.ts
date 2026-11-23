/**
 * An inbox read without a limit returns every matching chat message.
 * GetLifeOpsInboxRequest.limit: "When omitted, every matching message is
 * returned." InboxView sends GET /api/lifeops/inbox?channels=... without a
 * limit, and InboxDomain.getInbox then reads chat through fetchAllMessages
 * with no limit. fetchChatMessages used to put its own cap of 200 on that
 * read, so older chat messages were missing and channelCounts undercounted,
 * while Gmail and X DMs returned every row.
 *
 * Real PGLite AgentRuntime with stored Discord DM memories. The inbox cache
 * is the in-memory InboxMessageCache seam; the Gmail and X sources are not
 * requested and fail the test if called.
 */

import type {
  LifeOpsInboxChannel,
  LifeOpsInboxMessage,
} from "@elizaos/contracts";
import {
  type AgentRuntime,
  ChannelType,
  type Memory,
  stringToUuid,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
import {
  type CachedInboxMessage,
  InboxDomain,
  type InboxMessageCache,
} from "../src/inbox/aggregate.ts";
import { fetchAllMessages } from "../src/inbox/message-fetcher.ts";

/** More user messages than the old default cap of 200. */
const USER_MESSAGES = 205;
/** Agent replies, newer than every user message. */
const AGENT_REPLIES = 3;

/** In-memory InboxMessageCache that honors channels and maxResults. */
class MemoryInboxCache implements InboxMessageCache {
  rows = new Map<string, CachedInboxMessage>();

  async listCachedInboxMessages(
    _agentId: string,
    options?: {
      channels?: readonly LifeOpsInboxChannel[];
      maxResults?: number;
    },
  ): Promise<CachedInboxMessage[]> {
    const channels = options?.channels ? new Set(options.channels) : null;
    const out = [...this.rows.values()]
      .filter((row) => !channels || channels.has(row.channel))
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    return typeof options?.maxResults === "number"
      ? out.slice(0, options.maxResults)
      : out;
  }

  async upsertCachedInboxMessages(
    _agentId: string,
    messages: readonly LifeOpsInboxMessage[],
  ): Promise<void> {
    const cachedAt = new Date().toISOString();
    for (const message of messages) {
      this.rows.set(message.id, { ...message, cachedAt });
    }
  }

  async markCachedInboxMessageRead(): Promise<LifeOpsInboxMessage | null> {
    return null;
  }
}

function notRequested(source: string): () => Promise<never> {
  return async () => {
    throw new Error(`${source} was not requested`);
  };
}

describe("chat inbox read without a limit", () => {
  let testResult: RealTestRuntimeResult;
  let runtime: AgentRuntime;
  const userText = (index: number) => `user message ${index}`;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "chat-inbox-complete-read",
    });
    runtime = testResult.runtime;
    const roomId = stringToUuid("chat-inbox-complete-read-room");
    const entityId = stringToUuid("chat-inbox-complete-read-user");
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId: stringToUuid("chat-inbox-complete-read-world"),
      worldName: "discord",
      userName: "Ada",
      name: "Ada",
      source: "discord",
      type: ChannelType.DM,
      channelId: "chat-inbox-complete-read-channel",
    });
    const base = Date.now() - 60 * 60_000;
    const memories: Memory[] = [];
    for (let index = 0; index < USER_MESSAGES; index += 1) {
      memories.push({
        id: stringToUuid(`chat-inbox-complete-read-user-${index}`),
        agentId: runtime.agentId,
        roomId,
        entityId,
        content: { text: userText(index), source: "discord" },
        metadata: { type: "message", entityName: "Ada" },
        createdAt: base + index * 1_000,
      });
    }
    for (let index = 0; index < AGENT_REPLIES; index += 1) {
      memories.push({
        id: stringToUuid(`chat-inbox-complete-read-agent-${index}`),
        agentId: runtime.agentId,
        roomId,
        entityId: runtime.agentId,
        content: { text: `agent reply ${index}`, source: "discord" },
        metadata: { type: "message" },
        createdAt: base + (USER_MESSAGES + index) * 1_000,
      });
    }
    await runtime.createMemories(
      memories.map((memory) => ({ memory, tableName: "messages" })),
    );
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("InboxView's request lists and counts every Discord message", async () => {
    const domain = new InboxDomain({
      runtime,
      cache: new MemoryInboxCache(),
      sources: {
        getGoogleConnectorStatus: notRequested("Gmail"),
        getGmailTriage: notRequested("Gmail"),
        getXConnectorStatus: notRequested("X"),
        syncXDms: notRequested("X"),
        getXDms: notRequested("X"),
      },
      loadPriorityScoringSettings: async () => ({
        enabled: false,
        model: null,
      }),
    });

    const inbox = await domain.getInbox({ channels: ["discord"] });

    expect(inbox.channelCounts.discord.total).toBe(USER_MESSAGES);
    expect(inbox.messages).toHaveLength(USER_MESSAGES);
    expect(inbox.messages.at(-1)?.snippet).toBe(userText(0));
  });

  it("fetchAllMessages without a limit returns every chat message", async () => {
    const { messages } = await fetchAllMessages(runtime, {
      sources: ["discord"],
    });

    expect(messages.map((message) => message.text)).toEqual(
      Array.from({ length: USER_MESSAGES }, (_, index) =>
        userText(USER_MESSAGES - 1 - index),
      ),
    );
  });

  it("an explicit limit still returns only the newest messages", async () => {
    const { messages } = await fetchAllMessages(runtime, {
      sources: ["discord"],
      limit: 200,
    });

    expect(messages).toHaveLength(200);
    expect(messages[0]?.text).toBe(userText(USER_MESSAGES - 1));
    expect(messages.at(-1)?.text).toBe(userText(USER_MESSAGES - 200));
  });
});
