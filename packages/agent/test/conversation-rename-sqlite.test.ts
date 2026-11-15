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
import {
  ensureConversationRoom,
  handleConversationRoutes,
} from "../src/api/conversation-routes.ts";

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
      callerAuthorization: { ok: true, role: "OWNER" },
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

it("keeps timed-out connection writes exclusive, skips queued work, and admits a fresh retry", async () => {
  await withConversationRuntime(async (state, runtime) => {
    const entered = Promise.withResolvers<UUID>();
    const resume = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const ensureConnection = runtime.ensureConnection.bind(runtime);
    const writes = vi.spyOn(runtime, "ensureConnection");
    writes.mockImplementationOnce(async (input) => {
      entered.resolve(input.roomId);
      await resume.promise;
      try {
        await ensureConnection(input);
      } finally {
        finished.resolve();
      }
    });

    const creating = call(state, "POST", "/api/conversations", {
      title: "Held connection",
    });
    const requests = [creating];
    try {
      const roomId = await Promise.race([
        entered.promise,
        creating.then((result) => {
          throw new Error(
            `Creation completed before connection admission: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      const conversation = [...state.conversations.values()].find(
        (item) => item.roomId === roomId,
      );
      if (!conversation || !state.adminEntityId)
        throw new Error("Missing admitted conversation owner");

      // The public runtime prerequisite joins the same pending HTTP creation.
      const joined = ensureConversationRoom(state, runtime, conversation, {
        entityId: state.adminEntityId,
        role: "OWNER",
        userName: "User",
        grantSource: "owner",
      }).then(
        () => ({ code: "unexpected-success" }),
        (error: unknown) => ({
          code: (error as { code?: string }).code,
        }),
      );

      const queued = call(state, "POST", "/api/conversations", {
        title: "Queued connection",
      });
      requests.push(queued);
      await vi.waitFor(
        async () => {
          const result = await call(state, "GET", "/api/conversations");
          expect(result.status).toBe(200);
          expect(
            (result.payload as { conversations: unknown[] }).conversations,
          ).toHaveLength(2);
        },
        { timeout: 10_000 },
      );
      const queuedRoomId = [...state.conversations.values()].find(
        (item) => item.roomId !== roomId,
      )?.roomId;
      if (!queuedRoomId) throw new Error("Missing queued conversation");

      // Production deadlines run on the real clock. The first raw write is
      // held across both request failures and still owns the runtime queue.
      const deadlineFailure = {
        status: 500,
        payload: {
          error:
            "Failed to initialize conversation: Conversation connection reconciliation exceeded its deadline",
        },
      };
      expect(await creating).toEqual(deadlineFailure);
      expect(await queued).toEqual(deadlineFailure);
      expect(await joined).toEqual({
        code: "CONVERSATION_CONNECTION_TIMEOUT",
      });
      expect(writes).toHaveBeenCalledTimes(1);
      expect(state.conversations.size).toBe(0);

      const quarantineFailure = {
        status: 500,
        payload: {
          error:
            "Failed to initialize conversation: Conversation connection reconciliation is quarantined behind an unsettled write",
        },
      };
      expect(
        await call(state, "POST", "/api/conversations", {
          title: "Refused while quarantined",
        }),
      ).toEqual(quarantineFailure);
      expect(writes).toHaveBeenCalledTimes(1);
      expect(await runtime.getRoom(roomId)).toBeNull();
      expect(await runtime.getRoom(queuedRoomId)).toBeNull();

      resume.resolve();
      await finished.promise;
      // A fresh HTTP request observes recovery after the raw callback and the
      // remaining shared-world role writes settle. No private registry is read.
      let recovered: Awaited<ReturnType<typeof call>> = quarantineFailure;
      await vi.waitFor(
        async () => {
          recovered = await call(state, "POST", "/api/conversations", {
            title: "Fresh connection",
          });
          if (recovered.status !== 200)
            expect(recovered).toEqual(quarantineFailure);
          expect(recovered.status).toBe(200);
        },
        { timeout: 10_000 },
      );
      const fresh = (
        recovered.payload as {
          conversation: { id: string; roomId: UUID };
        }
      ).conversation;
      expect(await runtime.getRoom(roomId)).toMatchObject({ id: roomId });
      expect(await runtime.getRoom(queuedRoomId)).toBeNull();
      expect(await runtime.getRoom(fresh.roomId)).toMatchObject({
        name: "Fresh connection",
      });
      expect(writes).toHaveBeenCalledTimes(2);
      expect([...state.conversations.keys()]).toEqual([fresh.id]);
    } finally {
      resume.resolve();
      await Promise.allSettled(requests);
    }
  });
}, 90_000);

it("shares pending connection work and reconciles again after it settles", async () => {
  await withConversationRuntime(async (state, runtime) => {
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const ensureConnection = runtime.ensureConnection.bind(runtime);
    const writes = vi.spyOn(runtime, "ensureConnection");
    writes.mockImplementationOnce(async (input) => {
      entered.resolve();
      await resume.promise;
      await ensureConnection(input);
    });
    const creating = call(state, "POST", "/api/conversations", {
      title: "Shared connection",
    });
    try {
      await Promise.race([
        entered.promise,
        creating.then((result) => {
          throw new Error(
            `Creation completed before shared admission: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      const conversation = [...state.conversations.values()][0];
      if (!conversation || !state.adminEntityId)
        throw new Error("Missing admitted conversation owner");
      const caller = {
        entityId: state.adminEntityId,
        role: "OWNER" as const,
        userName: "User",
        grantSource: "owner" as const,
      };
      const first = ensureConversationRoom(
        state,
        runtime,
        conversation,
        caller,
      );
      const second = ensureConversationRoom(
        state,
        runtime,
        conversation,
        caller,
      );
      resume.resolve();
      const [response, firstDescriptor, secondDescriptor] = await Promise.all([
        creating,
        first,
        second,
      ]);
      expect(response.status).toBe(200);
      expect(firstDescriptor).toEqual(secondDescriptor);
      expect(writes).toHaveBeenCalledTimes(1);
      expect(await runtime.getRoom(conversation.roomId)).toMatchObject({
        name: "Shared connection",
      });

      // Settled success never caches readiness across a later request.
      await ensureConversationRoom(state, runtime, conversation, caller);
      expect(writes).toHaveBeenCalledTimes(2);
    } finally {
      resume.resolve();
      await creating;
    }
  });
}, 60_000);
