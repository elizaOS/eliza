/**
 * A Stop returns before the stream route saves the interrupted receipt of
 * the stopped turn. Real HTTP route and SQLite memory: the route announces
 * `conversation-updated` once that receipt is saved, so an open view can read
 * it, and a completed reply announces nothing new.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  type IMessageService,
  type Memory,
  type State,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createV5ReplyStrategyResult } from "../../../plugins/plugin-assistant/src/services/message/reply-policy.ts";
import {
  type ConversationRouteState,
  handleConversationRoutes,
} from "../src/api/conversation-routes.ts";

const REPLY = "It is nine o'clock.";

async function withRoute(
  turn: "stopped" | "completed",
  run: (fixture: {
    runtime: AgentRuntime;
    origin: string;
    started: Promise<void>;
    updates: Array<{ conversationId: string; rows: Promise<Memory[]> }>;
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "interrupted-receipt-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  const runtime = new AgentRuntime({
    agentId: randomUUID() as UUID,
    character: { name: "Receipt fixture", bio: [] },
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, "state.sqlite"),
      runtime.agentId,
    ),
  );
  const started = Promise.withResolvers<void>();
  const updates: Array<{ conversationId: string; rows: Promise<Memory[]> }> =
    [];
  let server: http.Server | undefined;
  try {
    await runtime.init();
    runtime.messageService = {
      handleMessage: async (_runtime, message) => {
        started.resolve();
        if (turn === "stopped") {
          // Held like a model call until the room's turn is stopped.
          return runtime.turnControllers.runWith(
            message.roomId,
            (signal) =>
              new Promise<never>((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                }),
              ),
          );
        }
        const strategy = createV5ReplyStrategyResult({
          runtime,
          message,
          state: {} as State,
          responseId: randomUUID() as UUID,
          text: REPLY,
          thought: "",
        });
        return {
          ...strategy,
          didRespond: true,
          outcome: { status: "completed", effects: [] },
        };
      },
      shouldRespond: () => {
        throw new Error("Unexpected response decision in route fixture");
      },
      deleteMessage: async () => {
        throw new Error("Unexpected message deletion in route fixture");
      },
      clearChannel: async () => {
        throw new Error("Unexpected channel clearing in route fixture");
      },
    } satisfies IMessageService;
    const owner = stringToUuid("interrupted-receipt-owner");
    const state: ConversationRouteState = {
      runtime,
      config: {} as ConversationRouteState["config"],
      agentName: "Receipt fixture",
      adminEntityId: owner,
      chatUserId: owner,
      logBuffer: [],
      conversations: new Map(),
      activeChatTurnCount: 0,
      conversationRestorePromise: null,
      deletedConversationIds: new Set(),
      broadcastWs: (data) => {
        const event = data as {
          type?: string;
          conversation?: { id: string; roomId: UUID };
        };
        if (event.type !== "conversation-updated" || !event.conversation)
          return;
        // Read the room as it stands when the event is sent.
        updates.push({
          conversationId: event.conversation.id,
          rows: runtime.getMemories({
            roomId: event.conversation.roomId,
            tableName: "messages",
            count: 20,
          }),
        });
      },
    };
    const route = http.createServer((req, res) => {
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
        callerAuthorization: {
          ok: true,
          role: "OWNER",
          identityId: "fixture-owner",
        } as never,
        readJsonBody: async (request) => {
          let body = "";
          for await (const chunk of request) body += chunk;
          return body ? JSON.parse(body) : null;
        },
        json,
        error: (response, message, status = 500) =>
          json(response, { error: message }, status),
      })
        .then((handled) => {
          if (!handled) json(res, { error: "Not found" }, 404);
        })
        .catch((error) => {
          if (!res.writableEnded) json(res, { error: String(error) }, 500);
        });
    });
    server = route;
    await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve));
    const address = route.address();
    if (!address || typeof address === "string")
      throw Error("Missing route address");
    await run({
      runtime,
      origin: `http://127.0.0.1:${address.port}`,
      started: started.promise,
      updates,
    });
  } finally {
    const open = server;
    if (open) {
      open.closeAllConnections();
      await new Promise<void>((resolve) => open.close(() => resolve()));
    }
    await runtime.stop();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}

async function createConversation(origin: string) {
  const created = await fetch(`${origin}/api/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Receipt fixture" }),
  });
  expect(created.status).toBe(200);
  return (
    (await created.json()) as { conversation: { id: string; roomId: UUID } }
  ).conversation;
}

function sendStream(origin: string, conversationId: string) {
  return fetch(
    `${origin}/api/conversations/${conversationId}/messages/stream`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "What time is it?",
        clientMessageId: randomUUID(),
      }),
    },
  );
}

function sseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

it("announces conversation-updated once the receipt of a stopped turn is saved", async () => {
  await withRoute("stopped", async ({ runtime, origin, started, updates }) => {
    const conversation = await createConversation(origin);
    updates.length = 0;
    const response = sendStream(origin, conversation.id);
    await started;
    expect(updates).toHaveLength(0);
    // The chat Stop route's call: it returns before the receipt is saved.
    expect(
      runtime.turnControllers.abortTurn(conversation.roomId, "user-stop"),
    ).toBe(true);
    const events = sseEvents(await (await response).text());
    expect(events.at(-1)).toMatchObject({ type: "done", interrupted: true });
    expect(updates.map((update) => update.conversationId)).toEqual([
      conversation.id,
    ]);
    const rows = await updates[0].rows;
    expect(
      rows.filter(
        (row) =>
          row.entityId === runtime.agentId && row.content.interrupted === true,
      ),
    ).toHaveLength(1);
  });
}, 60_000);

it("announces nothing new for a completed reply", async () => {
  await withRoute("completed", async ({ runtime, origin, updates }) => {
    const conversation = await createConversation(origin);
    updates.length = 0;
    const events = sseEvents(
      await (await sendStream(origin, conversation.id)).text(),
    );
    const done = events.find((event) => event.type === "done");
    expect(done?.fullText ?? done?.text).toBe(REPLY);
    expect(done?.interrupted).toBeUndefined();
    expect(updates).toHaveLength(0);
    const rows = await runtime.getMemories({
      roomId: conversation.roomId,
      tableName: "messages",
      count: 20,
    });
    expect(rows.map((row) => row.content.text).sort()).toEqual(
      [REPLY, "What time is it?"].sort(),
    );
  });
}, 60_000);
