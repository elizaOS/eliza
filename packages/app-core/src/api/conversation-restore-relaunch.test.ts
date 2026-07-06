/**
 * Real relaunch/server-truth persistence e2e for web-chat conversations (#13689).
 *
 * "My conversation is still there after I reopen the app" had no automated
 * assertion that isn't mock-substituted: the web spec asserts reload against an
 * in-spec mock store, so it proves client rehydration, not the real agent-DB
 * round trip. This drives the REAL restore path (`restoreConversationsFromDb`,
 * extracted from the server boot closure so it is testable) against a REAL,
 * migrated PGlite database.
 *
 * The first leg is the real assertion this issue was missing:
 *   route-send unique messages -> persist to on-disk PGlite -> close/reopen a
 *   new runtime against the same data dir -> restore -> GET messages returns
 *   the same ids, order, content, and per-message metadata from server truth.
 *
 * Plus the guards a real regression would trip: a fresh registry with no
 * persisted rooms restores nothing (no fabrication), non-web-chat rooms are
 * ignored, an already-loaded conversation is not duplicated, and a
 * deleted-this-session id is never resurrected.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { restoreConversationsFromDb } from "@elizaos/agent/api/conversation-restore";
import type { ConversationRouteState } from "@elizaos/agent/api/conversation-routes";
import { handleConversationRoutes } from "@elizaos/agent/api/conversation-routes";
import type { ConversationMeta } from "@elizaos/agent/api/server-types";
import {
  AgentRuntime,
  type AgentRuntime as AgentRuntimeType,
  ChannelType,
  type Plugin,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import { createTestDatabase } from "@elizaos/plugin-sql/__tests__/test-helpers";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockCharacter } from "../../../../plugins/plugin-sql/src/__tests__/schema-data/index.ts";
import { DatabaseMigrationService } from "../../../../plugins/plugin-sql/src/migration-service.ts";
import { PgliteDatabaseAdapter } from "../../../../plugins/plugin-sql/src/pglite/adapter.ts";
import { PGliteClientManager } from "../../../../plugins/plugin-sql/src/pglite/manager.ts";
import type { DrizzleDatabase } from "../../../../plugins/plugin-sql/src/types.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000136890" as UUID;

let runtime: AgentRuntimeType;
let cleanup: () => Promise<void>;
let worldId: UUID;

interface PersistentRuntimeHandle {
  adapter: PgliteDatabaseAdapter;
  runtime: AgentRuntimeType;
  close: () => Promise<void>;
}

async function openPersistentRuntime(
  agentId: UUID,
  dataDir: string,
  testPlugins: Plugin[] = [],
  migrate = false,
): Promise<PersistentRuntimeHandle> {
  const connectionManager = new PGliteClientManager({ dataDir });
  await connectionManager.initialize();
  const adapter = new PgliteDatabaseAdapter(agentId, connectionManager);
  await adapter.init();

  const openedRuntime = new AgentRuntime({
    character: { ...mockCharacter, id: undefined },
    agentId,
    plugins: [sqlPlugin, ...testPlugins],
  });
  openedRuntime.registerDatabaseAdapter(adapter);

  if (migrate) {
    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(
      adapter.getDatabase() as DrizzleDatabase,
    );
    migrationService.discoverAndRegisterPluginSchemas([
      sqlPlugin,
      ...testPlugins,
    ]);
    await migrationService.runAllPluginMigrations();

    await (adapter.getDatabase() as DrizzleDatabase).execute(
      sql`delete from agents where id = ${agentId}`,
    );
    const created = await adapter.createAgent({
      ...mockCharacter,
      id: agentId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    if (!created) {
      throw new Error(`Failed to create persistent test agent ${agentId}`);
    }
  }

  return {
    adapter,
    runtime: openedRuntime,
    close: async () => adapter.close(),
  };
}

function createRouteState(
  routeRuntime: AgentRuntimeType,
  conversations = new Map<string, ConversationMeta>(),
): ConversationRouteState {
  const adminId = stringToUuid("chat-persistence-admin");
  return {
    runtime: routeRuntime,
    agentState: "running",
    awaitRuntimeReady: null,
    config: { user: { name: "Persistence Tester" } } as never,
    agentName: routeRuntime.character.name ?? "Eliza",
    adminEntityId: adminId,
    chatUserId: adminId,
    logBuffer: [],
    conversations,
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
    tradePermissionMode: "connectors-only",
  };
}

async function callConversationRoute<TBody extends Record<string, unknown>>(
  state: ConversationRouteState,
  method: string,
  pathname: string,
  body: TBody | null = null,
): Promise<{ status: number; payload: unknown }> {
  let status = 200;
  let payload: unknown;
  const req = Object.assign(new http.IncomingMessage(null as never), {
    method,
    url: pathname,
    headers: { host: "localhost" },
  }) as http.IncomingMessage;
  const res = {
    setHeader: () => undefined,
    write: () => true,
    end: () => undefined,
    writableEnded: false,
  } as unknown as http.ServerResponse;
  const handled = await handleConversationRoutes({
    req,
    res,
    method,
    pathname,
    state,
    readJsonBody: async () => body,
    json: (_res: http.ServerResponse, value: unknown, code?: number) => {
      status = code ?? 200;
      payload = value;
    },
    error: (_res: http.ServerResponse, message: string, code = 500) => {
      status = code;
      payload = { error: message };
    },
  } as never);
  expect(handled).toBe(true);
  return { status, payload };
}

function expectObjectPayload<T extends Record<string, unknown>>(response: {
  status: number;
  payload: unknown;
}): T {
  expect(
    response.status,
    JSON.stringify(response.payload),
  ).toBeGreaterThanOrEqual(200);
  expect(response.status, JSON.stringify(response.payload)).toBeLessThan(300);
  expect(response.payload).toBeTypeOf("object");
  expect(response.payload).not.toBeNull();
  return response.payload as T;
}

/** Persist a web-chat conversation (world+room) with one marker message. */
async function seedConversation(
  convId: string,
  markerText: string,
  channelIdOverride?: string,
): Promise<UUID> {
  const roomId = stringToUuid(`room-${convId}`);
  await runtime.createRoom({
    id: roomId,
    name: `Chat ${convId}`,
    source: "web",
    type: ChannelType.DM,
    channelId: channelIdOverride ?? `web-conv-${convId}`,
    worldId,
  });
  await runtime.createMemory(
    {
      entityId: runtime.agentId,
      roomId,
      content: { text: markerText },
    } as never,
    "messages",
  );
  return roomId;
}

beforeAll(async () => {
  const db = await createTestDatabase(AGENT_ID, [sqlPlugin]);
  runtime = db.runtime;
  cleanup = db.cleanup;
  worldId = stringToUuid(`${runtime.character.name ?? "Eliza"}-web-chat-world`);
  await runtime.createWorld({
    id: worldId,
    name: "web-chat",
    agentId: runtime.agentId,
    serverId: "test-server",
  } as never);
  // Marker messages are authored by the agent entity; satisfy the memories FK.
  await runtime.createEntity({
    id: runtime.agentId,
    agentId: runtime.agentId,
    names: ["Agent"],
  } as never);
});

afterAll(async () => {
  await cleanup?.();
});

describe("web-chat conversation relaunch persistence — real DB (#13689)", () => {
  it("sends messages through the real route, restarts the PGlite store, restores, and returns intact history", async () => {
    const agentId = "00000000-0000-0000-0000-000000136892" as UUID;
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "eliza-chat-persist-"),
    );
    let first: PersistentRuntimeHandle | null = null;
    let restarted: PersistentRuntimeHandle | null = null;

    try {
      first = await openPersistentRuntime(agentId, dataDir, [sqlPlugin], true);
      const firstState = createRouteState(first.runtime);
      await first.runtime.createEntity({
        id: first.runtime.agentId,
        agentId: first.runtime.agentId,
        names: ["Agent"],
      } as never);
      await first.runtime.createEntity({
        id: firstState.chatUserId,
        agentId: first.runtime.agentId,
        names: ["Persistence Tester"],
      } as never);
      const created = expectObjectPayload<{ conversation: ConversationMeta }>(
        await callConversationRoute(firstState, "POST", "/api/conversations", {
          title: "Restart persistence proof",
          metadata: {
            scope: "general",
            taskId: "13689-real-restart",
            workflowName: "app-device",
          },
        }),
      );
      const conv = created.conversation;
      const sentAt = Date.now();
      const firstText = `wallet transfer token RELAUNCH-PERSIST-FIRST-${sentAt}`;
      const secondText = `wallet address RELAUNCH-PERSIST-SECOND-${sentAt}`;

      for (const [idx, text] of [firstText, secondText].entries()) {
        const sent = await callConversationRoute(
          firstState,
          "POST",
          `/api/conversations/${conv.id}/messages`,
          {
            text,
            channelType: "dm",
            source: "chat-persistence-real-route",
            metadata: {
              markerIndex: idx,
              runId: String(sentAt),
              persistedBy: "POST /api/conversations/:id/messages",
            },
          },
        );
        expect(sent.status).toBe(200);
      }

      const beforeRestart = await first.runtime.getMemories({
        roomId: conv.roomId,
        tableName: "messages",
        limit: 20,
      });
      const storedUserMessages = beforeRestart
        .filter((memory) => memory.entityId !== first?.runtime.agentId)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      expect(storedUserMessages.map((m) => m.content.text)).toEqual([
        firstText,
        secondText,
      ]);
      const persistedIds = storedUserMessages.map((m) => m.id);
      expect(persistedIds.every(Boolean)).toBe(true);

      await first.close();
      first = null;

      // Real restart: reopen a new adapter/runtime against the same on-disk
      // PGlite data dir. The in-memory conversation registry starts empty.
      restarted = await openPersistentRuntime(agentId, dataDir, [sqlPlugin]);
      const restartedState = createRouteState(restarted.runtime);
      const restored = await restoreConversationsFromDb(restarted.runtime, {
        conversations: restartedState.conversations,
        deletedConversationIds: restartedState.deletedConversationIds,
      });
      expect(restored).toBe(1);
      expect(restartedState.conversations.get(conv.id)).toMatchObject({
        id: conv.id,
        roomId: conv.roomId,
        metadata: {
          scope: "general",
          taskId: "13689-real-restart",
          workflowName: "app-device",
        },
      });

      const afterRestart = await restarted.runtime.getMemories({
        roomId: conv.roomId,
        tableName: "messages",
        limit: 20,
      });
      const restoredUserMessages = afterRestart
        .filter((memory) => memory.entityId !== restarted?.runtime.agentId)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      expect(restoredUserMessages.map((m) => m.id)).toEqual(persistedIds);
      expect(restoredUserMessages.map((m) => m.content.text)).toEqual([
        firstText,
        secondText,
      ]);
      expect(
        restoredUserMessages.map(
          (m) => (m.content.metadata as Record<string, unknown>).markerIndex,
        ),
      ).toEqual([0, 1]);
      expect(
        restoredUserMessages.map(
          (m) => (m.content.metadata as Record<string, unknown>).runId,
        ),
      ).toEqual([String(sentAt), String(sentAt)]);

      const listed = expectObjectPayload<{
        messages: Array<{ id: string; role: string; text: string }>;
      }>(
        await callConversationRoute(
          restartedState,
          "GET",
          `/api/conversations/${conv.id}/messages`,
        ),
      );
      const visibleUserMessages = listed.messages.filter(
        (message) => message.role === "user",
      );
      expect(visibleUserMessages.map((message) => message.id)).toEqual(
        persistedIds,
      );
      expect(visibleUserMessages.map((message) => message.text)).toEqual([
        firstText,
        secondText,
      ]);
    } finally {
      await first?.close();
      await restarted?.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("restores a persisted conversation from DB truth after a relaunch and the marker message survives", async () => {
    const convId = "aaaaaaaa-1111-2222-3333-444444444444";
    const marker = `MARKER-relaunch-${convId}`;
    const roomId = await seedConversation(convId, marker);

    // Relaunch: a fresh process has an empty in-memory conversation registry.
    const conversations = new Map();
    const deletedConversationIds = new Set<string>();
    const restored = await restoreConversationsFromDb(runtime, {
      conversations,
      deletedConversationIds,
    });

    // The conversation is rebuilt from server truth, mapped to its real room.
    expect(restored).toBe(1);
    expect(conversations.has(convId)).toBe(true);
    expect(conversations.get(convId)).toMatchObject({
      id: convId,
      roomId,
      title: `Chat ${convId}`,
    });

    // And the sent message is still there, read from the real DB, not
    // optimistic client state.
    const msgs = await runtime.getMemories({
      roomId,
      tableName: "messages",
      limit: 10,
    });
    expect(
      msgs.some((m) => (m.content as { text?: string })?.text === marker),
    ).toBe(true);
  });

  it("restores nothing into a fresh registry when no web-chat rooms are persisted (no fabrication)", async () => {
    // A pristine runtime/world with no rooms at all.
    const empty = await createTestDatabase(
      "00000000-0000-0000-0000-000000136891" as UUID,
      [sqlPlugin],
    );
    try {
      const conversations = new Map();
      const restored = await restoreConversationsFromDb(empty.runtime, {
        conversations,
        deletedConversationIds: new Set(),
      });
      expect(restored).toBe(0);
      expect(conversations.size).toBe(0);
    } finally {
      await empty.cleanup();
    }
  });

  it("ignores non-web-chat rooms and does not duplicate an already-loaded conversation", async () => {
    const convId = "bbbbbbbb-1111-2222-3333-555555555555";
    await seedConversation(convId, "second-marker");
    // A room in the same world that is NOT a web-chat conversation.
    await seedConversation(
      "cccccccc-9999-9999-9999-999999999999",
      "discord-noise",
      "discord-channel-xyz",
    );

    const conversations = new Map();
    const first = await restoreConversationsFromDb(runtime, {
      conversations,
      deletedConversationIds: new Set(),
    });
    // Only the two web-conv rooms (this test's + the first test's) restore; the
    // discord-channel room is skipped.
    expect(first).toBeGreaterThanOrEqual(1);
    expect([...conversations.keys()]).toContain(convId);
    expect([...conversations.keys()]).not.toContain(
      "cccccccc-9999-9999-9999-999999999999",
    );

    // Re-running against the now-populated registry restores no duplicates.
    const second = await restoreConversationsFromDb(runtime, {
      conversations,
      deletedConversationIds: new Set(),
    });
    expect(second).toBe(0);
  });

  it("never resurrects a conversation the operator deleted this session", async () => {
    const convId = "dddddddd-1111-2222-3333-666666666666";
    await seedConversation(convId, "deleted-marker");

    const conversations = new Map();
    const restored = await restoreConversationsFromDb(runtime, {
      conversations,
      deletedConversationIds: new Set([convId]),
    });
    expect(conversations.has(convId)).toBe(false);
    // (other web-conv rooms may still restore; the deleted one must not)
    expect([...conversations.keys()]).not.toContain(convId);
    expect(restored).toBeGreaterThanOrEqual(0);
  });
});
