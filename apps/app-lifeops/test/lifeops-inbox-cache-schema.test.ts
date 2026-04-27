import type { LifeOpsInboxMessage } from "@elizaos/shared";
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
    };

    await repository.upsertCachedInboxMessages(agentId, [message]);
    const cached = await repository.listCachedInboxMessages(agentId, {
      channels: ["gmail"],
      maxResults: 10,
    });

    expect(cached).toHaveLength(1);
    expect(cached[0]?.id).toBe("gmail:message-1");
    expect(cached[0]?.snippet).toBe("fresh");
  });
});
