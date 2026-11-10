/**
 * On SQLite, renaming a web conversation or changing its metadata must reach
 * the stored room: after a restart the conversation list is rebuilt from the
 * rooms. The SQLite adapter has updateRooms but no updateRoom, so a direct
 * adapter.updateRoom check skipped the write while the route answered 200.
 * The same real HTTP and SQLite fixture checks readiness across deletion.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AgentRuntime, stringToUuid, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { restoreConversationsFromDb } from "../src/api/conversation-restore.ts";
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

async function withConversationRuntime(
  run: (state: ConversationRouteState, runtime: AgentRuntime) => Promise<void>,
): Promise<void> {
  const agentId = randomUUID() as UUID;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "conv-rename-sqlite-"));
  const runtime = new AgentRuntime({
    agentId,
    character: { name: "Rename Agent", bio: [], settings: {} },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(path.join(dataDir, "state.sqlite"), agentId),
  );
  vi.stubEnv("ELIZA_STATE_DIR", dataDir);
  try {
    await runtime.init();
    const adminId = stringToUuid("rename-admin");
    await runtime.createEntity({
      id: adminId,
      agentId,
      names: ["User"],
    } as never);
    const state = {
      runtime,
      config: { user: { name: "User" } },
      agentName: "Rename Agent",
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

    await run(state, runtime);
  } finally {
    vi.unstubAllEnvs();
    await runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

it("keeps a conversation rename on SQLite after the list is rebuilt from the database", async () => {
  await withConversationRuntime(async (state, runtime) => {
    const created = await call(state, "POST", "/api/conversations", {
      title: "New chat",
    });
    const conversation = (
      created.payload as { conversation: { id: string; roomId: UUID } }
    ).conversation;
    const renamed = await call(
      state,
      "PATCH",
      `/api/conversations/${conversation.id}`,
      { title: "Taxes" },
    );
    expect(renamed.status).toBe(200);
    expect((await runtime.getRoom(conversation.roomId))?.name).toBe("Taxes");

    // A restart rebuilds the conversation list from the stored rooms.
    state.conversations.clear();
    await restoreConversationsFromDb(runtime, state);
    expect(
      [...state.conversations.values()].map((restored) => restored.title),
    ).toEqual(["Taxes"]);
  });
}, 60_000);

it("rejects creation when the conversation is deleted during room setup", async () => {
  await withConversationRuntime(async (state, runtime) => {
    const syncing = Promise.withResolvers<UUID>();
    const resume = Promise.withResolvers<void>();
    const ensureConnection = runtime.ensureConnection.bind(runtime);
    const getRoom = runtime.getRoom.bind(runtime);
    vi.spyOn(runtime, "ensureConnection").mockImplementationOnce(
      async (input) => {
        await ensureConnection(input);
        // Pause the first metadata read after the real connection is established.
        vi.spyOn(runtime, "getRoom").mockImplementationOnce(async (id) => {
          const room = await getRoom(id);
          syncing.resolve(id);
          await resume.promise;
          return room;
        });
      },
    );

    const creating = call(state, "POST", "/api/conversations", {
      title: "Deleted during setup",
    });
    try {
      const roomId = await Promise.race([
        syncing.promise,
        creating.then((result) => {
          throw new Error(
            `Creation completed before metadata sync: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      const listed = await call(state, "GET", "/api/conversations");
      expect(listed.status).toBe(200);
      const { conversations } = listed.payload as {
        conversations: { id: string; roomId: UUID }[];
      };
      const conversation = conversations.find((item) => item.roomId === roomId);
      if (!conversation) throw new Error("Missing provisional conversation");
      expect(
        await call(state, "DELETE", `/api/conversations/${conversation.id}`),
      ).toEqual({ status: 200, payload: { ok: true } });
      expect(await runtime.getRoom(roomId)).toBeNull();
    } finally {
      resume.resolve();
      await creating;
    }
    expect(await creating).toEqual({
      status: 500,
      payload: {
        error:
          "Failed to initialize conversation: Conversation connection descriptor was invalidated",
      },
    });
  });
}, 60_000);
