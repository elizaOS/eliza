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
import {
  restoreConversationFromDb,
  restoreConversationsFromDb,
} from "../src/api/conversation-restore.ts";
import type { ConversationRouteState } from "../src/api/conversation-routes.ts";
import { handleConversationRoutes } from "../src/api/conversation-routes.ts";

async function call(
  state: ConversationRouteState,
  method: string,
  url: string,
  body: Record<string, unknown> | null = null,
): Promise<{ status: number; payload: unknown }> {
  const server = http.createServer((req, res) => {
    const json = (
      response: http.ServerResponse,
      value: unknown,
      status = 200,
    ) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    void handleConversationRoutes({
      req,
      res,
      method: req.method ?? "GET",
      pathname: new URL(req.url ?? "/", "http://localhost").pathname,
      state,
      readJsonBody: async (request) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        return chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString())
          : null;
      },
      json,
      error: (response, message, status = 500) =>
        json(response, { error: message }, status),
    })
      .then((handled) => {
        if (!handled) json(res, { error: "Not found" }, 404);
      })
      .catch((error: unknown) => {
        json(res, { error: String(error) }, 500);
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing HTTP address");
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, {
      method,
      ...(body
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    return { status: response.status, payload: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function createFixture() {
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
  return { agentId, adapter, adminId, dataDir, runtime, state };
}

it("restores an evicted conversation so it stays readable and deletable", async () => {
  const { agentId, adapter, adminId, dataDir, runtime, state } =
    await createFixture();
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

it("does not restore a conversation from a room outside the web-chat world", async () => {
  const { adapter, dataDir, runtime, state } = await createFixture();
  try {
    const convId = "not-a-web-chat";
    await runtime.createRooms([
      {
        id: stringToUuid(`web-conv-${convId}`),
        agentId: runtime.agentId,
        name: "Other room",
        source: "discord",
        type: "GROUP",
        channelId: `web-conv-${convId}`,
        worldId: stringToUuid("some-other-world"),
      } as never,
    ]);

    const messages = await call(
      state,
      "GET",
      `/api/conversations/${convId}/messages`,
    );

    expect(messages.status).toBe(404);
    expect(state.conversations.size).toBe(0);
  } finally {
    await adapter.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 120_000);

it("restores a conversation stored in the world keyed by an earlier agent name", async () => {
  const { adapter, dataDir, runtime, state } = await createFixture();
  try {
    const convId = "from-earlier-name";
    const roomId = stringToUuid(`web-conv-${convId}`);
    await runtime.createRooms([
      {
        id: roomId,
        agentId: runtime.agentId,
        name: "Earlier chat",
        source: "client_chat",
        type: "DM",
        channelId: `web-conv-${convId}`,
        // The fixture's agent entity is named "Agent"; its character is "Evict Agent".
        worldId: stringToUuid("Agent-web-chat-world"),
      } as never,
    ]);
    expect(await restoreConversationsFromDb(runtime, state)).toBe(1);
    state.conversations.clear();
    expect(
      (await restoreConversationFromDb(runtime, state, convId))?.roomId,
    ).toBe(roomId);
  } finally {
    await adapter.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 120_000);

it.each(["lookup", "boot", "concurrent"] as const)(
  "preserves conversation identity across a delayed database restore (%s)",
  async (mode) => {
    const { adapter, dataDir, runtime, state } = await createFixture();
    const original = runtime.getMemories;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const reading = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let restoring: Promise<unknown> | undefined;
    try {
      const created = await call(state, "POST", "/api/conversations", {
        title: "Stored conversation",
      });
      expect(created.status).toBe(200);
      const { conversation } = created.payload as {
        conversation: { id: string; roomId: UUID };
      };
      state.conversations.delete(conversation.id);
      let gated = false;
      runtime.getMemories = async (params) => {
        const memories = await original.call(runtime, params);
        if (
          !gated &&
          params.roomId === conversation.roomId &&
          params.limit === 1
        ) {
          gated = true;
          reached();
          await gate;
        }
        return memories;
      };
      restoring =
        mode === "boot"
          ? restoreConversationsFromDb(runtime, state)
          : restoreConversationFromDb(runtime, state, conversation.id);
      await reading;
      if (mode === "concurrent") {
        const current = await restoreConversationFromDb(
          runtime,
          state,
          conversation.id,
        );
        expect(current).toBeDefined();
        const renamed = await call(
          state,
          "PATCH",
          `/api/conversations/${conversation.id}`,
          { title: "Renamed while restoring" },
        );
        expect(renamed.status).toBe(200);
        release();
        expect(await restoring).toBe(current);
        expect(state.conversations.get(conversation.id)).toBe(current);
        expect(current?.title).toBe("Renamed while restoring");
      } else {
        const deleted = await call(
          state,
          "DELETE",
          `/api/conversations/${conversation.id}`,
        );
        expect(deleted.status).toBe(200);
        expect(state.deletedConversationIds.has(conversation.id)).toBe(true);
        release();
        expect(await restoring).toBe(mode === "boot" ? 0 : undefined);
        expect(state.conversations.has(conversation.id)).toBe(false);
        expect(await runtime.getRoom(conversation.roomId)).toBeNull();
        expect(
          (
            await call(
              state,
              "GET",
              `/api/conversations/${conversation.id}/messages`,
            )
          ).status,
        ).toBe(404);
      }
    } finally {
      release();
      await restoring;
      runtime.getMemories = original;
      await adapter.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  },
  120_000,
);
