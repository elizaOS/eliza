/**
 * Every web conversation stays in the registry: past 500 conversations the
 * oldest one is still listed and its messages are still searchable. A
 * conversation missing from the registry while its room and messages are
 * persisted is rebuilt from its room instead of being reported missing or
 * skipping the delete of its stored data.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  createCharacter,
  createModelAttemptAllowance,
  ModelType,
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
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import { handleTextSmall } from "../../../plugins/plugin-openai/models/text.ts";
import { streamElizaConversation } from "../../host/src/voice/eliza-sse-bridge.ts";
import { createLocalRuntimeConversationFetch } from "../../host/src/voice/local-runtime-conversation-fetch.ts";
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

it("keeps the oldest of 501 conversations listed and searchable, and rebuilds a registry miss", async () => {
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

    // 501 conversations: the oldest is still listed and searchable.
    const listed = await call(state, "GET", "/api/conversations");
    const ids = (
      listed.payload as { conversations: Array<{ id: string }> }
    ).conversations.map((conversation) => conversation.id);
    expect(ids).toHaveLength(501);
    expect(ids).toContain(first.id);
    const found = await call(
      state,
      "GET",
      "/api/conversations/messages/search?q=remember",
    );
    expect(JSON.stringify(found.payload)).toContain("remember my first chat");

    // A registry miss is rebuilt from the persisted room.
    state.conversations.delete(first.id);

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

it("does not restore a conversation from a room that is not a web chat", async () => {
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

it("restores a conversation of the same agent id from the world of an earlier name", async () => {
  const { adapter, dataDir, runtime, state } = await createFixture();
  try {
    const created = await call(state, "POST", "/api/conversations", {
      title: "Chat before the rename",
    });
    const { conversation } = created.payload as {
      conversation: { id: string; roomId: UUID };
    };
    runtime.character.name = "Renamed Agent";
    state.conversations.clear();

    expect(await restoreConversationsFromDb(runtime, state)).toBe(1);
    expect(state.conversations.get(conversation.id)?.roomId).toBe(
      conversation.roomId,
    );
    state.conversations.clear();
    expect(
      (await restoreConversationFromDb(runtime, state, conversation.id))
        ?.roomId,
    ).toBe(conversation.roomId);
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

it("waits for the boot restore before answering a message search", async () => {
  const { agentId, adapter, adminId, dataDir, runtime, state } =
    await createFixture();
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
    const { conversation } = created.payload as {
      conversation: { id: string; roomId: UUID };
    };
    await runtime.createMemory(
      {
        entityId: adminId,
        agentId,
        roomId: conversation.roomId,
        content: { text: "the pineapple invoice is overdue" },
      } as never,
      "messages",
    );
    // A relaunch starts with an empty registry and a restore in flight.
    state.conversations.clear();
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
    restoring = restoreConversationsFromDb(runtime, state);
    // The restore stays blocked until the route asks for it, so a route that
    // does not wait answers from the empty registry.
    const pending = restoring.then(() => undefined);
    Object.defineProperty(state, "conversationRestorePromise", {
      get: () => {
        release();
        return pending;
      },
    });
    await reading;
    expect(state.conversations.size).toBe(0);

    const searched = await call(
      state,
      "GET",
      "/api/conversations/messages/search?q=pineapple",
    );

    expect(searched.status).toBe(200);
    const { results } = searched.payload as {
      results: Array<{ conversationId: string; text: string }>;
    };
    expect(results).toEqual([
      expect.objectContaining({
        conversationId: conversation.id,
        text: "the pineapple invoice is overdue",
      }),
    ]);
  } finally {
    release();
    await restoring;
    runtime.getMemories = original;
    await adapter.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}, 120_000);

it.each(["\ud800", "valid-prefix\udfffsuffix"])(
  "rejects an import source identity with a lone surrogate before any write: %j",
  async (sourceId) => {
    const { adapter, dataDir, runtime, state } = await createFixture();
    try {
      const convId = "malformed-import";
      const imported = await call(
        state,
        "POST",
        `/api/conversations/${convId}/import`,
        {
          messages: [
            { role: "user", text: "first", sourceId: "source-1" },
            { role: "user", text: "second", sourceId },
          ],
        },
      );
      expect(imported).toEqual({
        status: 400,
        payload: {
          error: "Imported message sourceIds must contain well-formed Unicode",
        },
      });
      expect(state.conversations.has(convId)).toBe(false);
      expect(
        await runtime.getMemories({
          roomId: stringToUuid(`web-conv-${convId}`),
          tableName: "messages",
          count: 10,
        }),
      ).toEqual([]);
    } finally {
      await adapter.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  },
  120_000,
);

it("binds the real voice bridge, loopback route and model wire to one host trial", async () => {
  vi.stubEnv("ELIZA_TRAJECTORY_LOGGING", "0");
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", "0");
  const modelRequests: Record<string, unknown>[] = [];
  const model = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    modelRequests.push(payload);
    const text = JSON.stringify({
      thought: "Answer directly",
      text: "Ready.",
      actions: ["REPLY"],
      providers: [],
    });
    if (payload.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = {
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture-model",
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      };
      res.end(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "fixture",
          object: "chat.completion",
          created: 1,
          model: "fixture-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const modelAddress = model.address();
  if (!modelAddress || typeof modelAddress === "string")
    throw Error("Missing model address");
  const baseURL = `http://127.0.0.1:${modelAddress.port}/v1`;
  const runtime = createSQLiteTestRuntime({
    character: createCharacter({
      name: "Bounded voice fixture",
      settings: {
        OPENAI_BASE_URL: baseURL,
        OPENAI_API_KEY: "fixture-only",
        OPENAI_SMALL_MODEL: "fixture-model",
      },
    }),
    plugins: [createAssistantPlugin()],
    enableAutonomy: false,
    logLevel: "fatal",
  });
  runtime.registerModel(
    ModelType.TEXT_EMBEDDING,
    async () => [1, ...Array(383).fill(0)],
    "local-fixture",
  );
  for (const key of [
    ModelType.RESPONSE_HANDLER,
    ModelType.ACTION_PLANNER,
    ModelType.TEXT_SMALL,
  ])
    runtime.registerModel(key, handleTextSmall, "openai", 100);
  let server: http.Server | undefined;
  const stop = new AbortController();
  try {
    await runtime.initialize();
    const reported = vi.spyOn(runtime, "reportError");
    for (const key of [
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
      ModelType.TEXT_SMALL,
    ])
      runtime.registerModel(key, handleTextSmall, "openai", 100);
    const state: ConversationRouteState = {
      runtime,
      config: {} as ConversationRouteState["config"],
      agentName: "Bounded voice fixture",
      adminEntityId: stringToUuid("voice-budget-owner"),
      chatUserId: stringToUuid("voice-budget-owner"),
      logBuffer: [],
      conversations: new Map(),
      activeChatTurnCount: 0,
      conversationRestorePromise: null,
      deletedConversationIds: new Set(),
      broadcastWs: null,
    };
    const created = await call(state, "POST", "/api/conversations", {
      title: "Bounded fixture",
    });
    const conversation = (created.payload as { conversation: { id: string } })
      .conversation;
    const allowance = createModelAttemptAllowance({
      signal: stop.signal,
      budgetMicroUsd: 1000000,
      maxAttempts: 1,
      maxOutputTokens: 128,
      expiresAt: Date.now() + 60000,
      tariffs: [
        {
          provider: "openai-compatible",
          model: "fixture-model",
          route: baseURL,
          inputNanoUsdPerToken: 100,
          outputNanoUsdPerToken: 100,
          inputTokenUpperBound: 262144,
        },
      ],
    });
    state.voiceModelPolicy = Object.freeze({
      policyId: "fixture-policy",
      sessionId: "fixture-session",
      ownerId: String(state.adminEntityId),
      agentId: String(runtime.agentId),
      conversationId: conversation.id,
      allowance,
    });
    server = http.createServer((req, res) => {
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
          role: req.headers["x-fixture-foreign"] ? "USER" : "OWNER",
          identityId: req.headers["x-fixture-foreign"]
            ? "foreign"
            : "fixture-owner",
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
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Missing route address");
    const origin = `http://127.0.0.1:${address.port}`;
    const adapter = createLocalRuntimeConversationFetch(origin, {
      agentId: String(runtime.agentId),
      conversationId: conversation.id,
    });
    const request = {
      endpoint: "https://fixture.invalid",
      authorization: "fixture-server-only",
      model: "unused",
      transcript: "Say ready.",
      agentId: String(runtime.agentId),
      conversationId: conversation.id,
      traceId: "a".repeat(32),
      signal: stop.signal,
      fetchImpl: adapter,
      modelAttemptPolicy: {
        policyId: "fixture-policy",
        sessionId: "fixture-session",
      },
    };
    for (const policy of [
      { policyId: "foreign-policy", sessionId: "fixture-session" },
      { policyId: "fixture-policy", sessionId: "foreign-session" },
    ])
      await expect(
        streamElizaConversation(
          { ...request, modelAttemptPolicy: policy },
          () => {},
        ),
      ).rejects.toThrow();
    await expect(
      streamElizaConversation(
        { ...request, modelAttemptPolicy: undefined },
        () => {},
      ),
    ).rejects.toThrow();
    const foreign = await fetch(
      origin + `/api/conversations/${conversation.id}/messages/stream`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Eliza-Voice-Model-Policy": "fixture-policy",
          "X-Eliza-Voice-Session-Id": "fixture-session",
          "X-Eliza-Local-Voice-Agent-Id": String(runtime.agentId),
          "X-Eliza-Local-Voice-Conversation-Id": conversation.id,
          "x-fixture-foreign": "1",
        },
        body: JSON.stringify({
          text: "Do not dispatch",
          channelType: "VOICE_DM",
        }),
      },
    );
    expect(await foreign.text()).toContain("Bounded voice model owner changed");
    expect(modelRequests).toHaveLength(0);
    const chunks: string[] = [];
    const result = await streamElizaConversation(request, (text) =>
      chunks.push(text),
    );
    expect(modelRequests).toHaveLength(1);
    expect(JSON.stringify(modelRequests[0])).toContain("Say ready.");
    expect(
      modelRequests[0].max_tokens ?? modelRequests[0].max_completion_tokens,
    ).toBe(128);
    expect(JSON.stringify(modelRequests[0])).not.toContain("fixture-policy");
    // A normal planner/recovery may need more than one attempt. Its explicit
    // refusal is allowed here; it is not proof of a usable real voice trial.
    expect(typeof result.completed).toBe("boolean");
    await streamElizaConversation(
      {
        ...request,
        traceId: "b".repeat(32),
        uiContext: {
          budgetMicroUsd: 999999999,
          maxAttempts: 999,
          modelAttemptTurnId: "foreign",
        } as never,
      },
      () => {},
    );
    expect(
      reported.mock.calls.some(
        (row) =>
          (row[1] as { code?: string })?.code ===
          "MODEL_ATTEMPT_POLICY_EXHAUSTED",
      ),
    ).toBe(true);
    expect(modelRequests).toHaveLength(1);
    allowance.close();
    await expect(
      streamElizaConversation(
        { ...request, traceId: "c".repeat(32) },
        () => {},
      ),
    ).rejects.toThrow();
    expect(modelRequests).toHaveLength(1);
  } finally {
    stop.abort();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    model.closeAllConnections();
    await new Promise<void>((resolve) => model.close(() => resolve()));
    await runtime.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
}, 60000);
