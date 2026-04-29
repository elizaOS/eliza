import type { LifeOpsInboxMessage } from "@elizaos/shared";
import type { LifeOpsXDm } from "@elizaos/shared/contracts/lifeops-extensions";
import { describe, expect, it } from "vitest";

import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { createLifeOpsChatTestRuntime } from "./helpers/lifeops-chat-runtime.js";

describe("LifeOps inbox cache schema repair", () => {
  it("does not require the optional inbox cache table in partial test schemas", async () => {
    const runtime = createLifeOpsChatTestRuntime({
      agentId: "inbox-cache-schema-partial-agent",
      useModel: async () => {
        throw new Error("useModel should not be called");
      },
      handleTurn: async () => ({ text: "ok" }),
    });

    await expect(
      LifeOpsRepository.ensureInboxCacheIndexes(runtime),
    ).resolves.toBeUndefined();
  });

  it("adds the inbox-cache conflict index for legacy tables", async () => {
    const runtime = createLifeOpsChatTestRuntime({
      agentId: "inbox-cache-schema-agent",
      useModel: async () => {
        throw new Error("useModel should not be called");
      },
      handleTurn: async () => ({ text: "ok" }),
    });
    const agentId = String(runtime.agentId);

    await runtime.adapter.db.execute({
      queryChunks: [
        {
          value: `
            CREATE TABLE life_inbox_messages (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              channel TEXT NOT NULL,
              external_id TEXT NOT NULL,
              thread_id TEXT,
              sender_id TEXT NOT NULL,
              sender_display TEXT NOT NULL,
              sender_email TEXT,
              subject TEXT,
              snippet TEXT NOT NULL DEFAULT '',
              received_at TEXT NOT NULL,
              is_unread BOOLEAN NOT NULL DEFAULT TRUE,
              deep_link TEXT,
              source_ref_json TEXT NOT NULL DEFAULT '{}',
              chat_type TEXT NOT NULL DEFAULT 'dm',
              participant_count INTEGER,
              gmail_account_id TEXT,
              gmail_account_email TEXT,
              priority_score INTEGER,
              priority_category TEXT,
              priority_flags_json TEXT NOT NULL DEFAULT '[]',
              cached_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            INSERT INTO life_inbox_messages (
              id, agent_id, channel, external_id, sender_id, sender_display,
              snippet, received_at, is_unread, source_ref_json,
              priority_flags_json, cached_at, updated_at
            ) VALUES
              (
                'old-row', '${agentId}', 'gmail', 'message-1', 'sender-1',
                'Old Sender', 'old', '2026-04-26T00:00:00.000Z', TRUE,
                '{"channel":"gmail","externalId":"message-1"}', '[]',
                '2026-04-26T00:00:00.000Z', '2026-04-26T00:00:00.000Z'
              ),
              (
                'new-row', '${agentId}', 'gmail', 'message-1', 'sender-1',
                'New Sender', 'new', '2026-04-26T01:00:00.000Z', TRUE,
                '{"channel":"gmail","externalId":"message-1"}', '[]',
                '2026-04-26T01:00:00.000Z', '2026-04-26T01:00:00.000Z'
              );
          `,
        },
      ],
    });

    await LifeOpsRepository.ensureInboxCacheIndexes(runtime);

    const repository = new LifeOpsRepository(runtime);
    const message: LifeOpsInboxMessage = {
      id: "gmail:message-1",
      channel: "gmail",
      sender: {
        id: "sender-1",
        displayName: "npm",
        email: "support@npmjs.com",
        avatarUrl: null,
      },
      subject: "npm",
      snippet: "fresh",
      receivedAt: "2026-04-26T23:50:16.000Z",
      unread: true,
      deepLink: "https://mail.google.com/mail/u/0/#all/message-1",
      sourceRef: {
        channel: "gmail",
        externalId: "message-1",
      },
      threadId: "message-1",
      lastSeenAt: "2026-04-26T23:55:00.000Z",
      repliedAt: "2026-04-26T23:56:00.000Z",
    };

    await repository.upsertCachedInboxMessages(agentId, [message]);
    await repository.upsertCachedInboxMessages(agentId, [
      {
        ...message,
        snippet: "fresh without state",
        lastSeenAt: undefined,
        repliedAt: undefined,
      },
    ]);
    const cached = await repository.listCachedInboxMessages(agentId, {
      channels: ["gmail"],
      maxResults: 10,
    });

    expect(cached).toHaveLength(1);
    expect(cached[0]?.id).toBe("gmail:message-1");
    expect(cached[0]?.snippet).toBe("fresh without state");
    expect(cached[0]?.lastSeenAt).toBe("2026-04-26T23:55:00.000Z");
    expect(cached[0]?.repliedAt).toBe("2026-04-26T23:56:00.000Z");
  });

  it("repairs optional cache columns required by current inbox writes", async () => {
    const runtime = createLifeOpsChatTestRuntime({
      agentId: "inbox-cache-optional-columns-agent",
      useModel: async () => {
        throw new Error("useModel should not be called");
      },
      handleTurn: async () => ({ text: "ok" }),
    });
    const agentId = String(runtime.agentId);

    await runtime.adapter.db.execute({
      queryChunks: [
        {
          value: `
            CREATE TABLE life_inbox_messages (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              channel TEXT NOT NULL,
              external_id TEXT NOT NULL,
              sender_id TEXT NOT NULL,
              sender_display TEXT NOT NULL,
              snippet TEXT NOT NULL DEFAULT '',
              received_at TEXT NOT NULL,
              is_unread BOOLEAN NOT NULL DEFAULT TRUE,
              cached_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
          `,
        },
      ],
    });

    await LifeOpsRepository.ensureInboxCacheIndexes(runtime);

    const repository = new LifeOpsRepository(runtime);
    await repository.upsertCachedInboxMessages(agentId, [
      {
        id: "telegram:message-1",
        channel: "telegram",
        sender: {
          id: "sender-1",
          displayName: "Alice",
          email: null,
          avatarUrl: null,
        },
        subject: null,
        snippet: "can the cache hold this?",
        receivedAt: "2026-04-26T23:50:16.000Z",
        unread: true,
        deepLink: "tg://resolve?domain=alice",
        sourceRef: {
          channel: "telegram",
          externalId: "message-1",
        },
        threadId: "telegram-room-1",
        participantCount: 3,
        priorityScore: 72,
        priorityCategory: "planning",
      },
    ]);

    const cached = await repository.listCachedInboxMessages(agentId, {
      channels: ["telegram"],
      maxResults: 10,
    });

    expect(cached).toHaveLength(1);
    expect(cached[0]?.chatType).toBe("group");
    expect(cached[0]?.priorityScore).toBe(72);
    expect(cached[0]?.priorityCategory).toBe("planning");
  });

  it("preserves cached priority flags unless a writer supplies new flags", async () => {
    const runtime = createLifeOpsChatTestRuntime({
      agentId: "inbox-cache-priority-flags-agent",
      useModel: async () => {
        throw new Error("useModel should not be called");
      },
      handleTurn: async () => ({ text: "ok" }),
    });
    await LifeOpsRepository.bootstrapSchema(runtime);
    const agentId = String(runtime.agentId);
    await runtime.adapter.db.execute({
      queryChunks: [
        {
          value: `
            CREATE TABLE life_inbox_messages (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              channel TEXT NOT NULL,
              external_id TEXT NOT NULL,
              thread_id TEXT,
              sender_id TEXT NOT NULL,
              sender_display TEXT NOT NULL,
              sender_email TEXT,
              subject TEXT,
              snippet TEXT NOT NULL DEFAULT '',
              received_at TEXT NOT NULL,
              is_unread BOOLEAN NOT NULL DEFAULT TRUE,
              deep_link TEXT,
              source_ref_json TEXT NOT NULL DEFAULT '{}',
              chat_type TEXT NOT NULL DEFAULT 'channel',
              participant_count INTEGER,
              gmail_account_id TEXT,
              gmail_account_email TEXT,
              last_seen_at TEXT,
              replied_at TEXT,
              priority_score INTEGER,
              priority_category TEXT,
              priority_flags_json TEXT NOT NULL DEFAULT '[]',
              cached_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(agent_id, channel, external_id)
            );
          `,
        },
      ],
    });
    const repository = new LifeOpsRepository(runtime);
    const message = {
      id: "telegram:priority-1",
      channel: "telegram",
      sender: {
        id: "sender-1",
        displayName: "Alice",
        email: null,
        avatarUrl: null,
      },
      subject: null,
      snippet: "priority cache",
      receivedAt: "2026-04-26T23:50:16.000Z",
      unread: true,
      deepLink: null,
      sourceRef: {
        channel: "telegram",
        externalId: "priority-1",
      },
      threadId: "telegram-room-1",
      chatType: "dm",
      priorityScore: 80,
      priorityCategory: "important",
      priorityFlags: ["needs_reply", "needs_reply", "owner_mention"],
    } satisfies LifeOpsInboxMessage & { priorityFlags: string[] };

    await repository.upsertCachedInboxMessages(agentId, [message]);
    const { priorityFlags: originalPriorityFlags, ...messageWithoutFlags } =
      message;
    expect(originalPriorityFlags).toEqual([
      "needs_reply",
      "needs_reply",
      "owner_mention",
    ]);
    await repository.upsertCachedInboxMessages(agentId, [
      {
        ...messageWithoutFlags,
        snippet: "rescored without flags",
        priorityScore: 90,
      },
    ]);
    let [cached] = await repository.listCachedInboxMessages(agentId, {
      channels: ["telegram"],
      maxResults: 1,
    });

    expect(cached?.snippet).toBe("rescored without flags");
    expect(cached?.priorityScore).toBe(90);
    expect(cached?.priorityFlags).toEqual(["needs_reply", "owner_mention"]);

    await repository.upsertCachedInboxMessages(agentId, [
      {
        ...message,
        priorityFlags: [],
      },
    ]);
    [cached] = await repository.listCachedInboxMessages(agentId, {
      channels: ["telegram"],
      maxResults: 1,
    });
    expect(cached?.priorityFlags).toEqual([]);
  });
});

describe("LifeOps X DM state preservation", () => {
  it("does not clear read/replied timestamps when a sync payload omits them", async () => {
    const runtime = createLifeOpsChatTestRuntime({
      agentId: "x-dm-state-preservation-agent",
      useModel: async () => {
        throw new Error("useModel should not be called");
      },
      handleTurn: async () => ({ text: "ok" }),
    });
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    await runtime.adapter.db.execute({
      queryChunks: [
        {
          value: `
            CREATE TABLE life_x_dms (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              external_dm_id TEXT NOT NULL,
              conversation_id TEXT NOT NULL,
              sender_handle TEXT NOT NULL,
              sender_id TEXT NOT NULL,
              is_inbound BOOLEAN NOT NULL,
              text TEXT NOT NULL,
              received_at TEXT NOT NULL,
              read_at TEXT,
              replied_at TEXT,
              metadata_json TEXT NOT NULL DEFAULT '{}',
              synced_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(agent_id, external_dm_id)
            );
          `,
        },
      ],
    });
    const baseDm: LifeOpsXDm = {
      id: "dm-1",
      agentId: String(runtime.agentId),
      externalDmId: "external-dm-1",
      conversationId: "conversation-1",
      senderHandle: "sender",
      senderId: "sender-id",
      isInbound: true,
      text: "hello",
      receivedAt: "2026-04-26T12:00:00.000Z",
      readAt: "2026-04-26T12:05:00.000Z",
      repliedAt: "2026-04-26T12:10:00.000Z",
      metadata: {},
      syncedAt: "2026-04-26T12:11:00.000Z",
      updatedAt: "2026-04-26T12:11:00.000Z",
    };

    await repository.upsertXDm(baseDm);
    await repository.upsertXDm({
      ...baseDm,
      text: "hello again",
      readAt: null,
      repliedAt: null,
      syncedAt: "2026-04-26T12:12:00.000Z",
      updatedAt: "2026-04-26T12:12:00.000Z",
    });

    const [dm] = await repository.listXDms(String(runtime.agentId), {
      limit: 1,
    });

    expect(dm?.text).toBe("hello again");
    expect(dm?.readAt).toBe("2026-04-26T12:05:00.000Z");
    expect(dm?.repliedAt).toBe("2026-04-26T12:10:00.000Z");
  });
});
