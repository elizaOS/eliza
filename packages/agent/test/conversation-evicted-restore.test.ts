/**
 * The conversation registry evicts the oldest entry past its soft cap while
 * the room and messages stay persisted; route lookups must rebuild an evicted
 * conversation from its room instead of reporting it missing or skipping the
 * delete of its stored data.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  createCharacter,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  DatabaseMigrationService,
  type DrizzleDatabase,
  PGliteClientManager,
  PgliteDatabaseAdapter,
  plugin as sqlPlugin,
} from "@elizaos/plugin-sql";
import { expect, it } from "vitest";
import type { ConversationRouteState } from "../src/api/conversation-routes.ts";
import { handleConversationRoutes } from "../src/api/conversation-routes.ts";

async function call(
  state: ConversationRouteState,
  method: string,
  url: string,
  body: Record<string, unknown> | null = null,
): Promise<{ status: number; payload: unknown }> {
  let status = 200;
  let payload: unknown;
  const req = Object.assign(new http.IncomingMessage(null as never), {
    method,
    url,
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  }) as http.IncomingMessage;
  const res = {
    setHeader: () => undefined,
    write: () => true,
    end: () => undefined,
    writableEnded: false,
  } as unknown as http.ServerResponse;
  await handleConversationRoutes({
    req,
    res,
    method,
    pathname: url.split("?")[0],
    state,
    readJsonBody: async () => body,
    json: (_r: unknown, v: unknown, c?: number) => {
      status = c ?? 200;
      payload = v;
    },
    error: (_r: unknown, m: string, c = 500) => {
      status = c;
      payload = { error: m };
    },
  } as never);
  return { status, payload };
}

it("restores an evicted conversation so it stays readable and deletable", async () => {
  const agentId = "00000000-0000-0000-0000-0000000a0d18" as UUID;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "evict-"));
  const cm = new PGliteClientManager({ dataDir });
  await cm.initialize();
  const adapter = new PgliteDatabaseAdapter(agentId, cm);
  await adapter.init();
  const character = createCharacter({ name: "Evict Agent", bio: [] });
  const runtime = new AgentRuntime({
    character: { ...character, id: undefined },
    agentId,
    plugins: [sqlPlugin],
  });
  runtime.registerDatabaseAdapter(adapter);
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(
    adapter.getDatabase() as DrizzleDatabase,
  );
  migrations.discoverAndRegisterPluginSchemas([sqlPlugin]);
  await migrations.runAllPluginMigrations();
  await adapter.createAgent({
    ...character,
    id: agentId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const adminId = stringToUuid("evict-admin");
  await runtime.createEntity({
    id: agentId,
    agentId,
    names: ["Agent"],
  } as never);
  await runtime.createEntity({
    id: adminId,
    agentId,
    names: ["User"],
  } as never);
  const state = {
    runtime,
    config: { user: { name: "User" } },
    agentName: "Evict Agent",
    adminEntityId: adminId,
    chatUserId: adminId,
    logBuffer: [],
    conversations: new Map(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
    tradePermissionMode: "connectors-only",
  } as unknown as ConversationRouteState;
  try {
    const created = await call(state, "POST", "/api/conversations", {
      title: "first chat",
    });
    const first = (
      created.payload as { conversation: { id: string; roomId: UUID } }
    ).conversation;
    await runtime.createMemory(
      {
        entityId: adminId,
        agentId,
        roomId: first.roomId,
        content: { text: "remember my first chat" },
      } as never,
      "messages",
    );
    const newer = new Date(Date.now() + 60_000).toISOString();
    for (let i = 0; i < 499; i += 1) {
      const id = `filler-${i}`;
      state.conversations.set(id, {
        id,
        title: id,
        roomId: stringToUuid(`web-conv-${id}`),
        createdAt: newer,
        updatedAt: newer,
      });
    }
    expect(
      (await call(state, "POST", "/api/conversations", { title: "latest" }))
        .status,
    ).toBe(200);
    expect(state.conversations.has(first.id)).toBe(false);

    const messages = await call(
      state,
      "GET",
      `/api/conversations/${first.id}/messages`,
    );
    expect(messages.status).toBe(200);
    expect(JSON.stringify(messages.payload)).toContain(
      "remember my first chat",
    );

    const deleted = await call(
      state,
      "DELETE",
      `/api/conversations/${first.id}`,
    );
    expect(deleted.status).toBe(200);
    expect(
      await runtime.getMemories({
        roomId: first.roomId,
        tableName: "messages",
      }),
    ).toEqual([]);
    expect(await runtime.getRoom(first.roomId)).toBeNull();
  } finally {
    await adapter.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 120_000);
