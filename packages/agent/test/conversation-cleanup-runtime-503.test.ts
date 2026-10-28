/**
 * Real-HTTP, deterministic probe of the empty-conversation cleanup route with
 * no agent runtime: the route must answer a visibly distinct 503 instead of a
 * fabricated `{ deleted: [] }` success that leaves the sweep silently undone.
 */

import http from "node:http";
import { expect, it } from "vitest";
import {
  type ConversationRouteState,
  handleConversationRoutes,
} from "../src/api/conversation-routes.ts";
import type { ConversationMeta } from "../src/api/server-types.ts";

function runtimeMissingState(): ConversationRouteState {
  return {
    runtime: null,
    config: {} as ConversationRouteState["config"],
    agentName: "CleanupProbe",
    adminEntityId: null,
    chatUserId: null,
    logBuffer: [],
    conversations: new Map(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
  };
}

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
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it("answers 503 from POST /api/conversations/cleanup-empty when the runtime is missing", async () => {
  const result = await call(
    runtimeMissingState(),
    "POST",
    "/api/conversations/cleanup-empty",
    {},
  );
  expect(result.status).toBe(503);
  expect(result.payload).toEqual({
    error: "Agent runtime not available",
  });
});

function stateWithConversation(): {
  state: ConversationRouteState;
  id: string;
} {
  const state = runtimeMissingState();
  const id = "conv-stopped-1";
  state.conversations.set(id, {
    id,
    title: "Original title",
    roomId:
      "11111111-1111-4111-8111-111111111111" as ConversationMeta["roomId"],
    createdAt: "2026-10-13T00:00:00.000Z",
    updatedAt: "2026-10-13T00:00:00.000Z",
  });
  return { state, id };
}

it("answers 503 from PATCH /api/conversations/:id when the runtime is missing", async () => {
  const { state, id } = stateWithConversation();
  const result = await call(state, "PATCH", `/api/conversations/${id}`, {
    title: "Renamed while stopped",
  });
  expect(result).toEqual({
    status: 503,
    payload: { error: "Agent is not running" },
  });
  // The in-process record did not change on its own: the room keeps the title.
  expect(state.conversations.get(id)?.title).toBe("Original title");
});

it("answers 503 from DELETE /api/conversations/:id when the runtime is missing", async () => {
  const { state, id } = stateWithConversation();
  const result = await call(state, "DELETE", `/api/conversations/${id}`);
  expect(result).toEqual({
    status: 503,
    payload: { error: "Agent is not running" },
  });
  // No tombstone without the room deletion that only the runtime can do.
  expect(state.deletedConversationIds.has(id)).toBe(false);
  expect(state.conversations.has(id)).toBe(true);
});
