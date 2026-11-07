/**
 * A window the transcript projection hides entirely (here scheduler prompts)
 * neither opens a chat empty nor ends upward scrolling. Real API server,
 * runtime and SQLite store; the real UI load-older helper drives the route.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  createMessageMemory,
  MESSAGE_SOURCE_CLIENT_CHAT,
  MESSAGE_SOURCE_TRIGGER_PROMPT,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import type { ConversationMessage } from "../../ui/src/api/client-types-chat.ts";
import { loadOlderConversationMessages } from "../../ui/src/state/load-older-conversation-messages.ts";
import { startApiServer } from "../src/api/server.ts";

type Seed = { source: string; text: string }[];

async function withSeededConversation(
  specs: Seed,
  check: (ctx: {
    base: string;
    conversationId: string;
    rows: Array<{ id?: UUID; createdAt?: number }>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "eliza-hidden-page-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  }))
    vi.stubEnv(key, value);
  const runtime = new AgentRuntime({
    character: { name: "Hidden page paging", bio: [], settings: {} },
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, "state.sqlite"),
      runtime.agentId,
    ),
  );
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    await runtime.init();
    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const created = await fetch(`${base}/api/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Hidden page" }),
    });
    const { conversation } = (await created.json()) as {
      conversation: { id: string; roomId: UUID };
    };
    const ownerId = randomUUID() as UUID;
    await runtime.createEntity({
      id: ownerId,
      agentId: runtime.agentId,
      names: ["Owner"],
    });
    await runtime.ensureParticipantInRoom(ownerId, conversation.roomId);

    const start = Date.now() - 1_000_000;
    const rows = specs.map((spec, index) => ({
      ...createMessageMemory({
        id: randomUUID() as UUID,
        entityId: ownerId,
        agentId: runtime.agentId,
        roomId: conversation.roomId,
        content: { text: spec.text, source: spec.source },
      }),
      createdAt: start + index * 1_000,
    }));
    for (const row of rows) await runtime.createMemory(row, "messages");
    await check({ base, conversationId: conversation.id, rows });
  } finally {
    if (server) await server.close();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}

it("reaches older turns below a page of hidden scheduler prompts", async () => {
  // Oldest first: 3 user turns, 60 scheduler prompts, 1 newest user turn.
  const specs = [
    ...[0, 1, 2].map((i) => ({
      source: MESSAGE_SOURCE_CLIENT_CHAT,
      text: `older turn ${i}`,
    })),
    ...Array.from({ length: 60 }, (_, i) => ({
      source: MESSAGE_SOURCE_TRIGGER_PROMPT,
      text: `Scheduled check ${i}`,
    })),
    { source: MESSAGE_SOURCE_CLIENT_CHAT, text: "newest turn" },
  ];
  await withSeededConversation(
    specs,
    async ({ base, conversationId, rows }) => {
      const newest = rows.at(-1);
      if (!newest?.id) throw new Error("seed failed");

      const client = {
        async getConversationMessages(
          id: string,
          options?: { before?: number; beforeId?: string; limit?: number },
        ) {
          const params = new URLSearchParams();
          if (options?.before !== undefined)
            params.set("before", String(options.before));
          if (options?.beforeId) params.set("beforeId", options.beforeId);
          if (options?.limit !== undefined)
            params.set("limit", String(options.limit));
          const response = await fetch(
            `${base}/api/conversations/${id}/messages?${params}`,
          );
          return (await response.json()) as {
            messages: ConversationMessage[];
            hasMore?: boolean;
          };
        },
      };
      const prepended: ConversationMessage[] = [];
      const result = await loadOlderConversationMessages({
        client,
        conversationId,
        currentMessages: [
          {
            id: newest.id,
            role: "user",
            text: "newest turn",
            timestamp: newest.createdAt,
          } as ConversationMessage,
        ],
        prependMessages: (older) => {
          prepended.unshift(...older);
          return older.length;
        },
        limit: 50,
      });

      expect(result.prependedCount).toBe(3);
      expect(prepended.map((message) => message.text)).toEqual([
        "older turn 0",
        "older turn 1",
        "older turn 2",
      ]);
    },
  );
}, 60_000);

it("opens a chat whose newest window is all scheduler prompts", async () => {
  // Oldest first: 2 chat turns, then 450 scheduler prompts with no reply, more
  // than two 200-row windows, so the read continues past several hidden pages.
  const specs = [
    { source: MESSAGE_SOURCE_CLIENT_CHAT, text: "Watch BTC every 5 minutes" },
    { source: MESSAGE_SOURCE_CLIENT_CHAT, text: "Only tell me under 50k" },
    ...Array.from({ length: 450 }, (_, i) => ({
      source: MESSAGE_SOURCE_TRIGGER_PROMPT,
      text: `Scheduled check ${i}`,
    })),
  ];
  await withSeededConversation(specs, async ({ base, conversationId }) => {
    const response = await fetch(
      `${base}/api/conversations/${conversationId}/messages`,
    );
    const { messages } = (await response.json()) as {
      messages: ConversationMessage[];
    };
    expect(messages.map((message) => message.text)).toEqual([
      "Watch BTC every 5 minutes",
      "Only tell me under 50k",
    ]);
  });
}, 60_000);
