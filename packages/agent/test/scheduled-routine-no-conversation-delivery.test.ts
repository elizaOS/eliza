/**
 * A routine fired on a fresh agent that has no conversation yet must not be
 * dropped while the scheduler records it as delivered (#31022).
 *
 * Real composition: SQLite AgentRuntime, the scheduling plugin (runner service
 * and durable record store), the personal assistant's production scheduled-task
 * dispatcher, the agent event bus, and the agent HTTP server. Without the
 * server there is no durable surface, so the dispatch is a typed failure. With
 * the server and still no conversation, the owner's canonical conversation is
 * created and the routine is in its history exactly once when a client
 * connects, and a replay of the same occurrence does not write a second row.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentEventService,
  ChannelType,
  createCharacter,
  isMessageMetadata,
  validateUuid,
} from "@elizaos/core";
import { installHttpPluginLifecycle } from "@elizaos/host/protocol";
import {
  createSchedulingRecordStores,
  type DispatchResult,
  getSchedulingRecordStore,
  registerScheduledTaskRunnerDeps,
  type ScheduledTaskDispatcher,
  type ScheduledTaskRunnerService,
  schedulingPlugin,
  waitForScheduledTaskRunnerService,
} from "@elizaos/plugin-scheduling";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import { createProductionScheduledTaskDispatcher } from "../../../plugins/plugin-personal-assistant/src/lifeops/scheduled-task/runtime-wiring.ts";
import { startApiServer } from "../src/api/server.ts";
import type { ConversationMeta } from "../src/api/server-types.ts";

const ROUTINE_SOURCE = "lifeops-scheduled-task";

interface HistoryMessage {
  id: string;
  role: string;
  text: string;
  source?: string;
}

it("persists a routine fired with no conversation into the owner's conversation exactly once", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "eliza-routine-noconv-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: "",
    ELIZA_REQUIRE_LOCAL_AUTH: "0",
  }))
    vi.stubEnv(key, value);
  const runtime = createSQLiteTestRuntime({
    plugins: [
      createAssistantPlugin(),
      // The agent host plugin's event bus (see src/runtime/eliza-plugin.ts).
      {
        name: "agent-event-host",
        description: "Agent event bus",
        services: [AgentEventService],
      },
      { ...schedulingPlugin, schema: undefined, dependencies: [] },
    ],
    character: createCharacter({ name: "NoConversationRoutine" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  let dispatcher: ScheduledTaskDispatcher | undefined;
  registerScheduledTaskRunnerDeps(runtime, (rt, agentId) => {
    const recordStore = getSchedulingRecordStore(rt);
    if (!recordStore) throw new Error("SQLite record store is required");
    const stores = createSchedulingRecordStores(recordStore, agentId);
    dispatcher = createProductionScheduledTaskDispatcher({ runtime: rt });
    return {
      store: stores.store,
      logStore: stores.logStore,
      dispatcher,
      ownerFacts: () => ({ timezone: "UTC" }),
      globalPause: { current: async () => ({ active: false }) },
      activity: { hasSignalSince: () => false },
      subjectStore: { wasUpdatedSince: () => false },
    };
  });
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    await runtime.initialize();
    installHttpPluginLifecycle(runtime);
    const service: ScheduledTaskRunnerService =
      await waitForScheduledTaskRunnerService(runtime);
    const runner = service.getRunner({ agentId: runtime.agentId });
    const getTask = async (taskId: string) =>
      (await runner.list()).find((task) => task.taskId === taskId);
    const scheduleRoutine = (label: string) =>
      runner.schedule({
        kind: "reminder",
        promptInstructions: `Remind the owner to ${label}.`,
        trigger: { kind: "manual" },
        priority: "low",
        respectsGlobalPause: true,
        source: "user_chat",
        createdBy: runtime.agentId,
        ownerVisible: true,
        output: { destination: "channel", target: "in_app" },
      });

    // Headless (no app server, no notification inbox): no durable surface
    // exists, so the fire records a typed failure, never a delivery.
    const headless = await scheduleRoutine("stretch");
    const headlessFire = await runner.fireWithResult(headless.taskId, {
      cause: "automatic",
    });
    const headlessTask = await getTask(headless.taskId);
    const headlessResult = headlessTask?.metadata?.lastDispatchResult as
      | DispatchResult
      | undefined;
    expect(headlessFire.kind).not.toBe("fired");
    expect(headlessResult).toMatchObject({ ok: false, reason: "disconnected" });

    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const request = async (route: string) => {
      const response = await fetch(`${base}${route}`, {
        headers: { "content-type": "application/json" },
      });
      const data = await response.json();
      expect(response.status, JSON.stringify(data)).toBeLessThan(300);
      return data;
    };
    const listConversations = async () =>
      (
        (await request("/api/conversations")) as {
          conversations: Array<{ id: string; roomId: string }>;
        }
      ).conversations;
    expect(await listConversations()).toEqual([]);

    // Fresh agent, no conversation, no client connected: the routine fires.
    const routine = await scheduleRoutine("drink water");
    const fire = await runner.fireWithResult(routine.taskId, {
      cause: "automatic",
    });
    expect(fire.kind).toBe("fired");
    const fired = await getTask(routine.taskId);
    const result = fired?.metadata?.lastDispatchResult as
      | Extract<DispatchResult, { ok: true }>
      | undefined;
    expect(result?.ok).toBe(true);
    const ownerChatRoomId = result?.metadata?.ownerChatRoomId;
    const ownerChatMessageId = result?.metadata?.ownerChatMessageId;
    expect(typeof ownerChatRoomId).toBe("string");
    expect(typeof ownerChatMessageId).toBe("string");

    // A client connects: the owner's conversation is listed and its history
    // holds the routine exactly once, under the id the scheduler recorded.
    const conversations = await listConversations();
    expect(conversations).toHaveLength(1);
    const [conversation] = conversations;
    expect(conversation?.roomId).toBe(ownerChatRoomId);
    expect(result?.metadata?.ownerChatConversationId).toBe(conversation?.id);
    const routineHistory = async () =>
      (
        (await request(`/api/conversations/${conversation?.id}/messages`)) as {
          messages: HistoryMessage[];
        }
      ).messages.filter((message) => message.source === ROUTINE_SOURCE);
    const delivered = await routineHistory();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      id: ownerChatMessageId,
      role: "assistant",
    });
    expect(delivered[0]?.text.trim().length).toBeGreaterThan(0);

    // Replaying the same occurrence (a crash after delivery, before the
    // scheduler recorded it) returns the stored row instead of a second one.
    if (!dispatcher || !fired) throw new Error("dispatcher was not built");
    const replayRecord = {
      taskId: fired.taskId,
      kind: fired.kind,
      firedAtIso: fired.state.firedAt ?? "",
      channelKey: "in_app",
      promptInstructions: fired.promptInstructions,
      contextRequest: fired.contextRequest,
      ownerVisible: fired.ownerVisible,
      output: fired.output,
      metadata: fired.metadata,
    } as const;
    const replay = await dispatcher.dispatch(replayRecord);
    expect(replay).toMatchObject({
      ok: true,
      metadata: {
        ownerChatMessageId,
        ownerChatConversationId: conversation?.id,
      },
    });
    expect(await listConversations()).toHaveLength(1);
    expect(await routineHistory()).toEqual(delivered);

    // A legacy row has no conversation selector. Resolve its stored room,
    // without rewriting history or guessing the current owner conversation.
    const messageId = validateUuid(ownerChatMessageId);
    if (!messageId) throw new Error("Persisted owner message ID missing");
    const persisted = await runtime.getMemoryById(messageId);
    if (!persisted) throw new Error("Persisted owner message missing");
    if (!persisted.metadata || !isMessageMetadata(persisted.metadata))
      throw new Error("Persisted message metadata missing");
    const legacy = {
      ...persisted,
      id: messageId,
      metadata: { ...persisted.metadata },
    };
    delete legacy.metadata.conversationId;
    await runtime.updateMemory(legacy);
    const legacyBeforeReplay = await runtime.getMemoryById(messageId);
    const legacyReplay = await dispatcher.dispatch(replayRecord);
    expect(legacyReplay).toMatchObject({
      ok: true,
      metadata: { ownerChatConversationId: conversation?.id },
    });
    expect(await runtime.getMemoryById(messageId)).toEqual(legacyBeforeReplay);

    const unmappedRoom = randomUUID();
    const ownerRoom = await runtime.getRoom(persisted.roomId);
    if (!ownerRoom?.worldId) throw new Error("Owner world missing");
    await runtime.ensureRoomExists({
      id: unmappedRoom,
      worldId: ownerRoom.worldId,
      source: "client_chat",
      type: ChannelType.DM,
    });
    await runtime.updateMemory({
      ...legacy,
      roomId: unmappedRoom,
      metadata: { ...legacy.metadata, conversationId: conversation?.id },
    });
    const unmappedBeforeReplay = await runtime.getMemoryById(messageId);
    const unmappedReplay = await dispatcher.dispatch(replayRecord);
    expect(unmappedReplay?.ok).toBe(true);
    if (!unmappedReplay?.ok) throw new Error("Legacy replay failed");
    expect(unmappedReplay.metadata?.ownerChatConversationId).toBeUndefined();
    expect(await runtime.getMemoryById(messageId)).toEqual(
      unmappedBeforeReplay,
    );
    expect(await listConversations()).toHaveLength(1);
  } finally {
    await server?.close();
    await runtime.stop();
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

it("waits for the backing owner room before concurrent callers receive its conversation", async () => {
  const { ensureOwnerConversation } = await import(
    "../src/api/conversation-routes.ts"
  );
  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "OwnerConversationRace" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  const state = {
    runtime,
    config: {},
    agentName: "OwnerConversationRace",
    adminEntityId: null,
    chatUserId: null,
    logBuffer: [],
    conversations: new Map(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set<string>(),
    broadcastWs: null,
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = runtime.ensureConnection.bind(runtime);
  const ensure = vi
    .spyOn(runtime, "ensureConnection")
    .mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
  let first: Promise<ConversationMeta> | undefined;
  let second: Promise<ConversationMeta> | undefined;
  try {
    await runtime.initialize();
    first = ensureOwnerConversation(state, runtime);
    await started;
    let secondResolved = false;
    second = ensureOwnerConversation(state, runtime).then((value) => {
      secondResolved = true;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondResolved).toBe(false);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe(b.id);
    expect(await runtime.getRoom(a.roomId)).toBeTruthy();
    expect(state.conversations.size).toBe(1);
  } finally {
    release();
    ensure.mockRestore();
    await Promise.allSettled([first, second]);
    await runtime.stop();
    await runtime.close();
  }
}, 120000);

it("rejects concurrent room setup together and permits a later successful retry", async () => {
  const { ensureOwnerConversation } = await import(
    "../src/api/conversation-routes.ts"
  );
  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "OwnerConversationRace" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  const state = {
    runtime,
    config: {},
    agentName: "OwnerConversationRace",
    adminEntityId: null,
    chatUserId: null,
    logBuffer: [],
    conversations: new Map(),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set<string>(),
    broadcastWs: null,
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = runtime.ensureConnection.bind(runtime);
  const ensure = vi
    .spyOn(runtime, "ensureConnection")
    .mockImplementation(async () => {
      entered();
      await gate;
      throw new Error("room setup rejected");
    });
  let first: Promise<ConversationMeta> | undefined;
  let second: Promise<ConversationMeta> | undefined;
  try {
    await runtime.initialize();
    first = ensureOwnerConversation(state, runtime);
    await started;
    second = ensureOwnerConversation(state, runtime);
    const settled = Promise.allSettled([first, second]);
    release();
    const results = await settled;
    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(state.conversations.size).toBe(0);
    ensure.mockImplementation(original);
    const retry = await ensureOwnerConversation(state, runtime);
    expect(await runtime.getRoom(retry.roomId)).toBeTruthy();
    expect(state.conversations.size).toBe(1);
  } finally {
    release();
    ensure.mockRestore();
    await Promise.allSettled([first, second]);
    await runtime.stop();
    await runtime.close();
  }
}, 120000);
