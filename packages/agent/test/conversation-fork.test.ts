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
import {
  AgentRuntime,
  createMessageMemory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
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

it("forks before an edited user message and preserves the original after restart", async () => {
  await withConversationRuntime(async (state, runtime) => {
    const created = await call(state, "POST", "/api/conversations", {
      title: "Original",
    });
    const source = (created.payload as any).conversation;
    const ids = [
      randomUUID(),
      randomUUID(),
      "77756d04-7407-0a15-9d28-be5782d10f5c",
      randomUUID(),
    ] as UUID[];
    const text = "Long original message\n".repeat(5000);
    const attachmentText = "Preserved attachment ".repeat(5000);
    for (let i = 0; i < 4; i++)
      await runtime.createMessageMemory({
        ...createMessageMemory({
          id: ids[i],
          entityId: i % 2 ? runtime.agentId : state.adminEntityId!,
          agentId: runtime.agentId,
          roomId: source.roomId,
          content: {
            text: i === 0 ? text : `message ${i}`,
            source: "client_chat",
            ...(i === 0
              ? {
                  attachments: [
                    {
                      id: randomUUID(),
                      url: "media://local-fixture",
                      title: "Original document",

                      text: attachmentText,
                    },
                  ],
                }
              : {}),
            ...(i === 1 ? { inReplyTo: ids[0] } : {}),
          },
        }),
        createdAt: 1000 + i,
      });
    const foreign = await call(
      state,
      "POST",
      `/api/conversations/${source.id}/fork`,
      { messageId: randomUUID(), requestId: randomUUID() },
    );
    expect(foreign.status).toBe(409);
    const initialCount = state.conversations.size;
    const request = { messageId: ids[2], requestId: randomUUID() };
    const response = await call(
      state,
      "POST",
      `/api/conversations/${source.id}/fork`,
      request,
    );
    expect(response.status).toBe(200);
    const fork = (response.payload as any).conversation;
    expect(fork.metadata.sourceConversationId).toBe(source.id);
    const originals = await runtime.getMemories({
      roomId: source.roomId,
      tableName: "messages",
      limit: 20,
    });
    expect(originals).toHaveLength(4);
    expect(state.conversations.size).toBe(initialCount + 1);
    const copied = await runtime.getMemories({
      roomId: fork.roomId,
      tableName: "messages",
      limit: 20,
    });
    expect(copied).toHaveLength(2);
    const first = copied.find(
      (row) =>
        (row.metadata as Record<string, unknown> | undefined)
          ?.forkSourceMessageId === ids[0],
    )!;
    const range = await runtime.adapter.readMessageContentRange!({
      agentId: runtime.agentId,
      messageId: first.id!,
      authorizedRoomId: fork.roomId,
      accessContext: { requesterEntityId: state.adminEntityId!, role: "OWNER" },
      source: { kind: "message-text" },
      offset: 0,
      limit: 1024,
    });
    expect(range.status).toBe("ok");
    if (range.status === "ok")
      expect(range.page.text).toBe(text.slice(0, 1024));
    expect(first.content.attachments?.[0].url).toBe("media://local-fixture");
    const attachment = first.content.attachments![0] as any;
    const attachmentRange = await runtime.adapter.readMessageContentRange!({
      agentId: runtime.agentId,
      messageId: first.id!,
      authorizedRoomId: fork.roomId,
      accessContext: { requesterEntityId: state.adminEntityId!, role: "OWNER" },
      source: {
        kind: "attachment-text",
        attachmentIdHash: attachment.textSource.attachmentIdHash,
      },
      offset: 0,
      limit: 1024,
    });
    expect(attachmentRange.status).toBe("ok");
    if (attachmentRange.status === "ok")
      expect(attachmentRange.page.text).toBe(attachmentText.slice(0, 1024));

    expect(copied.every((row) => !ids.includes(row.id!))).toBe(true);
    expect(
      copied.some(
        (row) =>
          row.content.inReplyTo ===
          copied.find(
            (m) =>
              (m.metadata as Record<string, unknown> | undefined)
                ?.forkSourceMessageId === ids[0],
          )?.id,
      ),
    ).toBe(true);
    const again = await call(
      state,
      "POST",
      `/api/conversations/${source.id}/fork`,
      request,
    );
    expect(again.status).toBe(200);
    expect((again.payload as any).conversation.id).toBe(fork.id);
    const changed = await call(
      state,
      "POST",
      `/api/conversations/${source.id}/fork`,
      { ...request, messageId: ids[0] },
    );
    expect(changed.status).toBe(409);
    state.conversations.clear();
    await restoreConversationsFromDb(runtime, state);
    expect(state.conversations.has(source.id)).toBe(true);
    expect(state.conversations.has(fork.id)).toBe(true);
  });
}, 60000);
