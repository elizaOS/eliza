/**
 * Functional SSE framing contract for the conversation stream route (#10712).
 *
 * Drives the real `/api/conversations/:id/messages/stream` handler
 * (`handleConversationRoutes` → `generateChatResponse`) with a deterministic
 * mock `runtime.useModel`, and asserts the frame contract the dashboard client
 * consumes: the SSE channel (headers + `thinking` status + heartbeat) opens
 * before any model work, `status` frames arrive in thinking → streaming order,
 * `token` frames are ordered with cumulative `fullText`, a terminal `done`
 * frame carries the full text plus the model `thought`, and failures after the
 * SSE channel opened surface as structured `error` data frames (never as a
 * late HTTP status rewrite).
 *
 * Scope note — this layer is provider-agnostic BY DESIGN. The route never
 * branches on which model-provider plugin resolves `runtime.useModel`
 * (local-inference vs cloud selection happens inside core's model registry),
 * so ONE deterministic case covers the whole route contract. An earlier
 * version of this file (`conversation-stream-provider-parity.test.ts`) ran the
 * same fixture twice under "local-inference" / "cloud-resolved" labels; both
 * cases executed byte-identical logic, so the matrix was collapsed. The real
 * provider-resolution path (real plugin, real model, real HTTP SSE) is
 * exercised live by
 * `packages/app-core/test/app/streaming-visible-text.live.e2e.test.ts`.
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import {
  type AgentRuntime,
  ChannelType,
  logger,
  type Memory,
  ModelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

// Per-test negotiated wire protocol the mocked payload reader advertises, so a
// single fixture drives both the legacy and delta-v2 framings through the real
// route handler.
let requestStreamProtocol: "delta-v2" | undefined;
let requestClientMessageId: string | undefined;

vi.mock("../chat-routes.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-routes.ts")>(
      "../chat-routes.ts",
    );
  return {
    ...actual,
    readChatRequestPayload: vi.fn(async () => ({
      prompt: "stream the deterministic thought",
      channelType: ChannelType.DM,
      images: undefined,
      preferredLanguage: undefined,
      source: "api",
      metadata: undefined,
      ...(requestStreamProtocol
        ? { streamProtocol: requestStreamProtocol }
        : {}),
      ...(requestClientMessageId
        ? { clientMessageId: requestClientMessageId }
        : {}),
    })),
    persistConversationMemory: vi.fn(async (_runtime, memory) => memory),
    persistAssistantConversationMemory: vi.fn(
      async (
        runtime,
        roomId,
        content,
        _channelType,
        _dedupeSinceMs,
        memoryId,
      ) =>
        ({
          id: memoryId ?? stringToUuid("stream-contract-assistant"),
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId,
          content:
            typeof content === "string" ? { text: content } : { ...content },
          createdAt: Date.now(),
        }) as never,
    ),
    resolveNoResponseFallback: () => "",
  };
});

vi.mock("../server-helpers.ts", async () => {
  const actual = await vi.importActual<typeof import("../server-helpers.ts")>(
    "../server-helpers.ts",
  );
  return {
    ...actual,
    buildUserMessages: vi.fn(({ prompt, userId, agentId, roomId }) => ({
      userMessage: {
        id: stringToUuid("stream-contract-user-msg"),
        entityId: userId,
        agentId,
        roomId,
        content: { text: prompt, source: "api", channelType: ChannelType.DM },
      },
      messageToStore: {
        id: stringToUuid("stream-contract-user-msg-store"),
        entityId: userId,
        agentId,
        roomId,
        content: { text: prompt, source: "api", channelType: ChannelType.DM },
      },
    })),
    resolveWalletModeGuidanceReply: () => null,
    resolveAppUserName: () => "tester",
  };
});

import {
  persistAssistantConversationMemory,
  persistConversationMemory,
} from "../chat-routes.ts";
import { serializeConversationConnectionRoomDeletion } from "../conversation-connection-readiness.ts";
import type {
  ConversationRouteContext,
  ConversationRouteState,
} from "../conversation-routes.ts";
import {
  handleConversationRoutes,
  persistRecentAssistantActionCallbackHistory,
} from "../conversation-routes.ts";

const AGENT_ID = stringToUuid("stream-contract-agent") as UUID;
const USER_ID = stringToUuid("stream-contract-user") as UUID;
const ROOM_ID = stringToUuid("stream-contract-room") as UUID;
const TOKENS = ["Ordered ", "token ", "frame ", "stream."];
const FINAL_TEXT = TOKENS.join("");
const THOUGHT =
  "Use the same deterministic token plan, then expose the compact reasoning.";

interface StreamingModelParams {
  prompt?: string;
  stream?: boolean;
  signal?: AbortSignal;
  onStreamChunk?: (chunk: string) => Promise<void> | void;
}

interface StreamingModelResult {
  text: string;
  thought: string;
}

interface MockResponseRecord {
  headers: Record<string, string>;
  writes: string[];
  ended: boolean;
}

type MockSocket = EventEmitter & {
  destroyed: boolean;
  writable: boolean;
};

function createMockSocket(): MockSocket {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    writable: true,
    remoteAddress: "127.0.0.1",
  });
}

function createReq(socket: MockSocket): http.IncomingMessage {
  const req = Object.assign(new http.IncomingMessage(null as never), {
    method: "POST",
    url: "/api/conversations/conv-1/messages/stream",
    headers: {},
  });
  Object.defineProperty(req, "socket", {
    configurable: true,
    value: socket,
  });
  return req as http.IncomingMessage;
}

function createMockRes(): {
  res: http.ServerResponse;
  record: MockResponseRecord;
} {
  const record: MockResponseRecord = {
    headers: {},
    writes: [],
    ended: false,
  };
  let writableEnded = false;
  const responseFixture = {
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      record.headers.status = String(status);
      Object.assign(record.headers, headers);
      return responseFixture;
    }),
    setHeader: vi.fn((name: string, value: string) => {
      record.headers[name] = value;
    }),
    write: vi.fn((chunk: string | Buffer) => {
      record.writes.push(
        typeof chunk === "string" ? chunk : chunk.toString("utf-8"),
      );
      return true;
    }),
    end: vi.fn(() => {
      record.ended = true;
      writableEnded = true;
    }),
    destroyed: false,
    get writableEnded() {
      return writableEnded;
    },
  } as unknown as http.ServerResponse;
  return { res: responseFixture, record };
}

function parseSsePayloads(writes: string[]): Array<Record<string, unknown>> {
  return writes
    .join("")
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")));
}

function createStreamingUseModelFixture() {
  return vi.fn(
    async (
      _modelType: string,
      params: StreamingModelParams,
    ): Promise<StreamingModelResult> => {
      expect(params.stream).toBe(true);
      expect(params.prompt).toContain("stream the deterministic thought");
      for (const token of TOKENS) {
        await Promise.resolve();
        await params.onStreamChunk?.(token);
      }
      return {
        text: FINAL_TEXT,
        thought: THOUGHT,
      };
    },
  );
}

function createModelBackedMessageService() {
  return {
    async handleMessage(
      runtime: AgentRuntime,
      message: { content?: { text?: unknown } },
      _callback: unknown,
      options?: {
        abortSignal?: AbortSignal;
        onStreamChunk?: (
          chunk: string,
          messageId?: string,
          accumulated?: string,
        ) => Promise<void> | void;
      },
    ) {
      const useStreamingModel = runtime.useModel as unknown as (
        modelType: typeof ModelType.TEXT_LARGE,
        params: StreamingModelParams,
      ) => Promise<StreamingModelResult>;
      const modelResult = await useStreamingModel(ModelType.TEXT_LARGE, {
        prompt: String(message.content?.text ?? ""),
        stream: true,
        signal: options?.abortSignal,
        onStreamChunk: options?.onStreamChunk,
      });
      return {
        didRespond: true,
        responseContent: {
          text: modelResult.text,
          thought: modelResult.thought,
        },
        responseMessages: [],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

/**
 * A message service that ignores useModel and drives the route's onStreamChunk
 * with a fixed chunk plan, so a test can force a mid-stream snapshot (a "replace"
 * update — chunk that revises earlier text) and assert the fullText-only frame
 * the delta writer emits for it.
 */
function createChunkPlanMessageService(
  chunks: Array<{ chunk: string; accumulated?: string }>,
  finalText: string,
  thought: string,
): NonNullable<AgentRuntime["messageService"]> {
  return {
    async handleMessage(
      _runtime: AgentRuntime,
      _message: { content?: { text?: unknown } },
      _callback: unknown,
      options?: {
        abortSignal?: AbortSignal;
        onStreamChunk?: (
          chunk: string,
          messageId?: string,
          accumulated?: string,
        ) => Promise<void> | void;
      },
    ) {
      for (const { chunk, accumulated } of chunks) {
        await Promise.resolve();
        await options?.onStreamChunk?.(chunk, undefined, accumulated);
      }
      return {
        didRespond: true,
        responseContent: { text: finalText, thought },
        responseMessages: [],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "stream-contract-snapshot-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createViewShortcutMessageService(): NonNullable<
  AgentRuntime["messageService"]
> {
  return {
    async handleMessage() {
      return {
        didRespond: true,
        responseContent: {
          text: "Navigated to Settings.",
          thought: "Shortcut: app-control:nl:view-navigation",
        },
        responseMessages: [],
        actionResults: [
          {
            success: true,
            text: "Navigated to Settings.",
            values: { mode: "show", viewId: "settings", viewType: "gui" },
            data: { actionName: "VIEWS" },
          },
        ],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "view-shortcut-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createVisibleCallbackWithInternalReceiptMessageService(): NonNullable<
  AgentRuntime["messageService"]
> {
  const text = "Opened Notes.";
  return {
    async handleMessage(_runtime, _message, callback) {
      await callback?.({ text }, "VIEWS");
      return {
        didRespond: true,
        responseContent: { text, transcriptVisibility: "internal" as const },
        responseMessages: [],
        mode: "actions" as const,
        actionResults: [
          {
            success: true,
            text,
            transcriptVisibility: "internal" as const,
            data: { actionName: "VIEWS" },
          },
        ],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "visible-callback-internal-receipt-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createFailedCallbackWithoutSyntheticFallbackMessageService(): NonNullable<
  AgentRuntime["messageService"]
> {
  const text =
    "I couldn't find a view called \"home\". You can try listing the available views to see what's there.";
  return {
    async handleMessage(_runtime, _message, callback) {
      await callback?.({ text }, "VIEWS");
      return {
        didRespond: true,
        responseContent: null,
        responseMessages: [],
        mode: "none" as const,
        actionResults: [
          {
            success: false,
            text,
            userFacingText: text,
            data: { actionName: "VIEWS" },
          },
        ],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "failed-callback-without-synthetic-fallback-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createPersistedCallbackMessageService(
  messageId: UUID,
): NonNullable<AgentRuntime["messageService"]> {
  const text = "Calendar is ready.";
  return {
    async handleMessage(_runtime, _message, callback) {
      await callback?.({ text, actions: ["CALENDAR"] }, "CALENDAR");
      return {
        didRespond: true,
        responseContent: { text, actions: ["CALENDAR"] },
        responseMessages: [
          {
            id: messageId,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text },
            createdAt: Date.now(),
          },
        ],
        persistedResponseMessageIds: [messageId],
        mode: "actions" as const,
        actionResults: [
          {
            success: true,
            text,
            data: { actionName: "CALENDAR" },
          },
        ],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "persisted-callback-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createGenericPersistedCallbackMessageService(
  messageId: UUID,
): NonNullable<AgentRuntime["messageService"]> {
  const text = "Simple delivery is ready.";
  return {
    async handleMessage(_runtime, _message, callback) {
      await callback?.({ text, actions: ["REPLY"] });
      return {
        didRespond: true,
        responseContent: { text, actions: ["REPLY"] },
        responseMessages: [
          {
            id: messageId,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text, actions: ["REPLY"] },
            createdAt: Date.now(),
          },
        ],
        persistedResponseMessageIds: [messageId],
        mode: "simple" as const,
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "generic-persisted-callback-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createPersistedReplyMessageService(): NonNullable<
  AgentRuntime["messageService"]
> {
  const id = stringToUuid("message-service-persisted-assistant");
  return {
    async handleMessage() {
      return {
        didRespond: true,
        responseContent: { text: "Already committed by message service." },
        responseMessages: [
          {
            id,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text: "Already committed by message service." },
          },
        ],
        persistedResponseMessageIds: [id],
        mode: "simple" as const,
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "persisted-reply-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createMixedPersistedTransientMessageService(
  persistedEarlyId: UUID,
  transientFinalId?: UUID,
): NonNullable<AgentRuntime["messageService"]> {
  return {
    async handleMessage(_runtime, _message, callback) {
      await callback?.({ text: "Final answer.", action: "VIEWS" });
      return {
        didRespond: true,
        responseContent: { text: "Final answer." },
        responseMessages: [
          {
            id: persistedEarlyId,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text: "Final answer." },
            createdAt: Date.now() - 1,
          },
          {
            id: transientFinalId,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text: "Final answer." },
            createdAt: Date.now(),
          },
        ],
        persistedResponseMessageIds: [persistedEarlyId],
        mode: "actions" as const,
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "mixed-persistence-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createEphemeralReplyMessageService(): NonNullable<
  AgentRuntime["messageService"]
> {
  return {
    async handleMessage() {
      const content = {
        text: "Temporary provider failure.",
        transient: true,
        doNotPersist: true,
        failureKind: "rate_limited" as const,
      };
      return {
        didRespond: true,
        responseContent: content,
        responseMessages: [
          {
            id: stringToUuid("ephemeral-assistant"),
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content,
          },
        ],
        mode: "simple" as const,
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "ephemeral-reply-stream-contract-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } satisfies NonNullable<AgentRuntime["messageService"]>;
}

function createState(
  messageServiceOverride?: NonNullable<AgentRuntime["messageService"]>,
): {
  state: ConversationRouteState;
  useModel: ReturnType<typeof createStreamingUseModelFixture>;
} {
  const conv = {
    id: "conv-1",
    title: "stream contract test conv",
    roomId: ROOM_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const useModel = createStreamingUseModelFixture();
  const worlds = new Map<
    UUID,
    {
      id: UUID;
      agentId: UUID;
      messageServerId?: UUID;
      metadata: Record<string, unknown>;
    }
  >();
  const storedMemories = new Map<UUID, Memory>();
  const runtime = {
    agentId: AGENT_ID,
    character: {
      name: "Streaming Agent",
      system: "System prompt",
      settings: {},
    },
    actions: [],
    plugins: [],
    logger,
    emitEvent: vi.fn(async () => undefined),
    useModel: useModel as unknown as AgentRuntime["useModel"],
    messageService: messageServiceOverride ?? createModelBackedMessageService(),
    ensureConnection: vi.fn(
      async (input: { worldId?: UUID; messageServerId?: UUID }) => {
        if (!input.worldId) throw new Error("worldId is required");
        if (!worlds.has(input.worldId)) {
          worlds.set(input.worldId, {
            id: input.worldId,
            agentId: AGENT_ID,
            messageServerId: input.messageServerId,
            metadata: {},
          });
        }
      },
    ),
    updateWorld: vi.fn(async () => undefined),
    getWorld: vi.fn(async (worldId: UUID) => worlds.get(worldId) ?? null),
    getRoom: vi.fn(async () => null),
    getParticipantsForRoom: vi.fn(async () => [USER_ID, AGENT_ID]),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn(() => null),
    drainChatPreHandlers: vi.fn(async () => null),
    createLogs: vi.fn(async () => undefined),
    createMemory: vi.fn(async (memory: Memory) => {
      if (memory.id) storedMemories.set(memory.id as UUID, memory);
      return memory.id;
    }),
    getMemoriesByIds: vi.fn(async (ids: UUID[]) => {
      const clientUserId = requestClientMessageId
        ? (stringToUuid(
            `conversation-user:${ROOM_ID}:${requestClientMessageId}`,
          ) as UUID)
        : null;
      return ids.flatMap((id) => {
        const stored = storedMemories.get(id);
        if (stored) return [stored];
        if (id === clientUserId) return [];
        return [
          {
            id,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text: "Calendar is ready." },
            createdAt: Date.now(),
          },
        ];
      });
    }),
    reportError: vi.fn(),
    adapter: {},
  } as unknown as AgentRuntime;

  return {
    useModel,
    state: {
      runtime,
      config: { user: { name: "tester" } } as never,
      agentName: "Streaming Agent",
      adminEntityId: USER_ID,
      chatUserId: USER_ID,
      logBuffer: [],
      conversations: new Map([[conv.id, conv]]),
      activeChatTurnCount: 0,
      conversationRestorePromise: null,
      deletedConversationIds: new Set(),
      broadcastWs: null,
    } as ConversationRouteState,
  };
}

function createCtx(
  messageServiceOverride?: NonNullable<AgentRuntime["messageService"]>,
): {
  ctx: ConversationRouteContext;
  record: MockResponseRecord;
  state: ConversationRouteState;
  useModel: ReturnType<typeof createStreamingUseModelFixture>;
} {
  const socket = createMockSocket();
  const req = createReq(socket);
  const { res, record } = createMockRes();
  const { state, useModel } = createState(messageServiceOverride);
  const ctx: ConversationRouteContext = {
    req,
    res,
    method: "POST",
    pathname: "/api/conversations/conv-1/messages/stream",
    state,
    readJsonBody: vi.fn(async () => ({ prompt: "unused" })),
    json: vi.fn(),
    error: vi.fn((response, message, status) => {
      response.write(`error ${status}: ${message}`);
      response.end();
    }),
  } as unknown as ConversationRouteContext;
  return { ctx, record, state, useModel };
}

function createFollowupCtx(
  baseCtx: ConversationRouteContext,
  state: ConversationRouteState,
): {
  ctx: ConversationRouteContext;
  record: MockResponseRecord;
} {
  const req = createReq(createMockSocket());
  const { res, record } = createMockRes();
  return {
    ctx: {
      ...baseCtx,
      req,
      res,
      state,
    },
    record,
  };
}

function createDeferred() {
  let resolve: (() => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: () => resolve?.(),
    reject: (reason: unknown) => reject?.(reason),
  };
}

function createGatedMessageService(
  started: ReturnType<typeof createDeferred>,
  gate: ReturnType<typeof createDeferred>,
): NonNullable<AgentRuntime["messageService"]> {
  return {
    async handleMessage() {
      started.resolve();
      await gate.promise;
      return {
        didRespond: true,
        responseContent: { text: FINAL_TEXT, thought: THOUGHT },
        responseMessages: [],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "stream-contract-gated-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  };
}

describe("conversation stream SSE contract (#10712)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    requestStreamProtocol = undefined;
    requestClientMessageId = undefined;
  });

  it("emits thinking→streaming status, ordered cumulative token frames, then a terminal done frame with thought", async () => {
    const { ctx, record, useModel } = createCtx();

    // Snapshot the wire at the moment the model is first invoked: the SSE
    // channel (headers + `thinking` status + heartbeat) must already be open
    // BEFORE any model work, so the client renders a live indicator during
    // the pre-model steps instead of staring at zero bytes.
    let writesAtModelCall: string[] | null = null;
    const streamImpl = useModel.getMockImplementation();
    if (!streamImpl) throw new Error("useModel fixture lost implementation");
    useModel.mockImplementation(async (modelType, params) => {
      if (writesAtModelCall === null) writesAtModelCall = [...record.writes];
      return streamImpl(modelType, params);
    });

    await handleConversationRoutes(ctx);

    expect(record.headers["Content-Type"]).toBe("text/event-stream");
    expect(record.ended).toBe(true);
    expect(useModel).toHaveBeenCalledTimes(1);

    const preModelFrames = parseSsePayloads(writesAtModelCall ?? []);
    expect(
      preModelFrames.some(
        (frame) => frame.type === "status" && frame.kind === "thinking",
      ),
    ).toBe(true);
    expect((writesAtModelCall ?? []).join("")).toContain(": heartbeat");

    const payloads = parseSsePayloads(record.writes);
    // The opening `thinking` status is the very first data frame on the wire.
    expect(payloads[0]).toMatchObject({ type: "status", kind: "thinking" });
    const tokens = payloads.filter((payload) => payload.type === "token");
    expect(tokens.map((payload) => payload.text)).toEqual(TOKENS);
    expect(tokens.map((payload) => payload.fullText)).toEqual([
      "Ordered ",
      "Ordered token ",
      "Ordered token frame ",
      FINAL_TEXT,
    ]);

    const doneIndex = payloads.findIndex((payload) => payload.type === "done");
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(payloads[doneIndex]).toMatchObject({
      type: "done",
      fullText: FINAL_TEXT,
      agentName: "Streaming Agent",
      thought: THOUGHT,
    });
    // `done` is emitted only after both ids are durable. The assistant id is
    // the one returned by persistence; the user id is the already-committed
    // request memory.
    const doneMessageId = payloads[doneIndex].messageId;
    const routeOwnedAssistantId = vi.mocked(persistAssistantConversationMemory)
      .mock.calls[0]?.[5];
    expect(routeOwnedAssistantId).toBeDefined();
    expect(doneMessageId).toBe(routeOwnedAssistantId);
    expect(payloads[doneIndex].userMessageId).toBe(
      stringToUuid("stream-contract-user-msg-store"),
    );
    expect(persistAssistantConversationMemory).toHaveBeenCalledWith(
      expect.anything(),
      ROOM_ID,
      expect.objectContaining({ text: FINAL_TEXT }),
      ChannelType.DM,
      expect.any(Number),
      routeOwnedAssistantId,
    );
    // `done` is terminal — no token frames after it.
    expect(
      payloads.slice(doneIndex + 1).some((payload) => payload.type === "token"),
    ).toBe(false);
    // The thought channel never leaks into the visible token stream.
    for (const token of tokens) {
      expect(String(token.fullText)).not.toContain(THOUGHT);
    }

    const statusKinds = payloads
      .filter((payload) => payload.type === "status")
      .map((payload) => payload.kind);
    // Exactly one `thinking` on the wire: the route emits it when the SSE
    // channel opens and collapses the identical opening status
    // generateChatResponse re-emits.
    expect(statusKinds).toEqual(["thinking", "streaming"]);
    // Both status frames precede the first token frame.
    const firstTokenIndex = payloads.findIndex(
      (payload) => payload.type === "token",
    );
    const streamingStatusIndex = payloads.findIndex(
      (payload) => payload.type === "status" && payload.kind === "streaming",
    );
    expect(streamingStatusIndex).toBeLessThan(firstTokenIndex);
  });

  it("awaits connection reconciliation before persistence and generation", async () => {
    const fixture = createCtx();
    const runtime = fixture.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    const refresh = createDeferred();
    const reconcile = vi
      .mocked(runtime.ensureConnection)
      .getMockImplementation();
    if (!reconcile) throw new Error("connection fixture missing");
    vi.mocked(runtime.ensureConnection).mockImplementationOnce(
      async (input) => {
        await refresh.promise;
        await reconcile(input);
      },
    );
    vi.mocked(persistConversationMemory).mockClear();
    fixture.useModel.mockClear();
    const turn = handleConversationRoutes(fixture.ctx);

    await vi.waitFor(() => {
      expect(runtime.ensureConnection).toHaveBeenCalledTimes(1);
    });
    expect(persistConversationMemory).not.toHaveBeenCalled();
    expect(fixture.useModel).not.toHaveBeenCalled();
    expect(fixture.record.ended).toBe(false);

    refresh.resolve();
    await turn;
    expect(persistConversationMemory).toHaveBeenCalledTimes(1);
    expect(fixture.useModel).toHaveBeenCalledTimes(1);
    expect(fixture.record.ended).toBe(true);
  });

  it("releases an undelivered connection failure for retry with the same id", async () => {
    requestClientMessageId = "connection-retry-id";
    const first = createCtx();
    const runtime = first.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    const failedRefresh = createDeferred();
    vi.mocked(runtime.ensureConnection).mockImplementationOnce(
      async () => failedRefresh.promise,
    );
    vi.mocked(persistConversationMemory).mockClear();
    vi.mocked(persistAssistantConversationMemory).mockClear();

    const firstTurn = handleConversationRoutes(first.ctx);
    await vi.waitFor(() => {
      expect(runtime.ensureConnection).toHaveBeenCalledTimes(1);
    });
    expect(first.useModel).not.toHaveBeenCalled();
    expect(persistConversationMemory).not.toHaveBeenCalled();

    failedRefresh.reject(new Error("role reconciliation failed"));
    await firstTurn;

    const failedPayloads = parseSsePayloads(first.record.writes);
    expect(failedPayloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("role reconciliation failed"),
      }),
    );
    expect(failedPayloads.some((payload) => payload.type === "done")).toBe(
      false,
    );
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();

    vi.mocked(runtime.ensureConnection).mockClear();
    first.useModel.mockClear();
    const retry = createFollowupCtx(first.ctx, first.state);
    await handleConversationRoutes(retry.ctx);

    expect(runtime.ensureConnection).toHaveBeenCalledTimes(1);
    expect(first.useModel).toHaveBeenCalledTimes(1);
    expect(
      parseSsePayloads(retry.record.writes).some(
        (payload) => payload.type === "done",
      ),
    ).toBe(true);
  });

  it("fails closed when the room is deleted after ensure and allows retry", async () => {
    requestClientMessageId = "delete-during-generation-id";
    const generationStarted = createDeferred();
    const generationGate = createDeferred();
    const first = createCtx(
      createGatedMessageService(generationStarted, generationGate),
    );
    const runtime = first.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(persistAssistantConversationMemory).mockClear();

    const turn = handleConversationRoutes(first.ctx);
    await generationStarted.promise;

    await serializeConversationConnectionRoomDeletion(
      runtime,
      ROOM_ID,
      async () => {},
    );
    generationGate.resolve();
    await turn;

    const payloads = parseSsePayloads(first.record.writes);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("invalidated"),
      }),
    );
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();

    runtime.messageService = createModelBackedMessageService();
    first.useModel.mockClear();
    const retry = createFollowupCtx(first.ctx, first.state);
    await handleConversationRoutes(retry.ctx);

    expect(first.useModel).toHaveBeenCalledTimes(1);
    expect(
      parseSsePayloads(retry.record.writes).some(
        (payload) => payload.type === "done",
      ),
    ).toBe(true);
  });

  it("fails the terminal frame if route state swaps runtimes mid-turn", async () => {
    const generationStarted = createDeferred();
    const generationGate = createDeferred();
    const first = createCtx(
      createGatedMessageService(generationStarted, generationGate),
    );
    const runtime = first.state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(persistAssistantConversationMemory).mockClear();

    const turn = handleConversationRoutes(first.ctx);
    await generationStarted.promise;

    const replacement = createState().state.runtime;
    if (!replacement) throw new Error("replacement fixture missing");
    first.state.runtime = replacement;
    generationGate.resolve();
    await turn;

    const payloads = parseSsePayloads(first.record.writes);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining("runtime changed"),
      }),
    );
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it("carries a direct VIEWS shortcut result on the terminal done frame", async () => {
    const { ctx, record } = createCtx(createViewShortcutMessageService());

    await handleConversationRoutes(ctx);

    const done = parseSsePayloads(record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(done).toMatchObject({
      type: "done",
      fullText: "Navigated to Settings.",
      thought: "Shortcut: app-control:nl:view-navigation",
      actionResults: [
        {
          actionName: "VIEWS",
          success: true,
          text: "Navigated to Settings.",
          values: { mode: "show", viewId: "settings", viewType: "gui" },
        },
      ],
    });
  });

  it("streams one visible callback when the matching action receipt is internal", async () => {
    requestStreamProtocol = "delta-v2";
    const { ctx, record, state } = createCtx(
      createVisibleCallbackWithInternalReceiptMessageService(),
    );
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    runtime.updateMemory = vi.fn(async () => true);
    vi.mocked(runtime.getMemoriesByIds).mockImplementation(async (ids) =>
      ids.map((id) => ({
        id,
        entityId: AGENT_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: { text: "Opened Notes." },
        createdAt: Date.now(),
      })),
    );

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads.filter((payload) => payload.type === "token")).toEqual([
      {
        type: "token",
        fullText: "Opened Notes.",
      },
    ]);
    const done = payloads.find((payload) => payload.type === "done");
    expect(done).toMatchObject({
      type: "done",
      fullText: "Opened Notes.",
      historyRefreshRequired: true,
      actionResults: [
        {
          actionName: "VIEWS",
          success: true,
          text: "Opened Notes.",
        },
      ],
    });
    expect(done).not.toHaveProperty("transcriptVisibility");
  });

  it("keeps a failed action callback authoritative through done and persistence", async () => {
    requestStreamProtocol = "delta-v2";
    const expectedFailure =
      "I couldn't find a view called \"home\". You can try listing the available views to see what's there.";
    const { ctx, record } = createCtx(
      createFailedCallbackWithoutSyntheticFallbackMessageService(),
    );
    vi.mocked(persistAssistantConversationMemory).mockClear();

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads.filter((payload) => payload.type === "token")).toEqual([
      {
        type: "token",
        fullText: expectedFailure,
      },
    ]);
    expect(payloads.some((payload) => payload.type === "error")).toBe(false);
    expect(JSON.stringify(payloads)).not.toContain("sorry, i hit a snag");
    expect(JSON.stringify(payloads)).not.toContain(
      "I tried to complete that, but the available runtime step failed before it produced a usable result.",
    );

    const done = payloads.find((payload) => payload.type === "done");
    expect(done).toMatchObject({
      type: "done",
      fullText: expectedFailure,
      actionResults: [
        {
          actionName: "VIEWS",
          success: false,
          text: expectedFailure,
        },
      ],
    });
    expect(persistAssistantConversationMemory).toHaveBeenCalledTimes(1);
    expect(persistAssistantConversationMemory).toHaveBeenCalledWith(
      expect.anything(),
      ROOM_ID,
      expect.objectContaining({ text: expectedFailure }),
      ChannelType.DM,
      expect.any(Number),
      expect.any(String),
    );
  });

  it("uses this turn's exact persisted response id instead of a room-latest guess", async () => {
    const responseId = stringToUuid("persisted-callback-response") as UUID;
    const { ctx, record, state } = createCtx(
      createPersistedCallbackMessageService(responseId),
    );
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockResolvedValueOnce([
      {
        id: responseId,
        entityId: AGENT_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: { text: "<response>Calendar is ready.</response>" },
        createdAt: Date.now(),
      },
    ]);
    runtime.updateMemory = vi.fn(async () => true);
    vi.mocked(persistAssistantConversationMemory).mockClear();

    await handleConversationRoutes(ctx);

    const done = parseSsePayloads(record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(done).toMatchObject({
      type: "done",
      fullText: "Calendar is ready.",
      messageId: responseId,
      userMessageId: stringToUuid("stream-contract-user-msg-store"),
      historyRefreshRequired: true,
    });
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it("does not request transcript reload for a generic persisted delivery callback", async () => {
    const responseId = stringToUuid("generic-persisted-callback") as UUID;
    const { ctx, record, state } = createCtx(
      createGenericPersistedCallbackMessageService(responseId),
    );
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    runtime.updateMemory = vi.fn(async () => true);

    await handleConversationRoutes(ctx);

    const done = parseSsePayloads(record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(done).toMatchObject({
      type: "done",
      fullText: "Simple delivery is ready.",
      messageId: responseId,
    });
    expect(done).not.toHaveProperty("historyRefreshRequired");
    expect(runtime.updateMemory).not.toHaveBeenCalled();
  });

  it("reuses the exact message-service commit without a route read or write", async () => {
    const { ctx, record, state } = createCtx(
      createPersistedReplyMessageService(),
    );
    if (!state.runtime) throw new Error("runtime fixture missing");
    const getMemoriesByIds = vi.mocked(state.runtime.getMemoriesByIds);
    getMemoriesByIds.mockClear();

    await handleConversationRoutes(ctx);

    const done = parseSsePayloads(record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(done).toMatchObject({
      type: "done",
      fullText: "Already committed by message service.",
      messageId: stringToUuid("message-service-persisted-assistant"),
      userMessageId: stringToUuid("stream-contract-user-msg-store"),
    });
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
    expect(getMemoriesByIds).not.toHaveBeenCalled();
  });

  it("emits an error instead of done when exact callback metadata cannot become durable", async () => {
    const responseId = stringToUuid("callback-write-failure-response") as UUID;
    const { ctx, record, state } = createCtx(
      createPersistedCallbackMessageService(responseId),
    );
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockResolvedValue([
      {
        id: responseId,
        entityId: AGENT_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: { text: "Calendar is ready." },
        createdAt: Date.now(),
      },
    ]);
    runtime.updateMemory = vi.fn(async () => {
      throw new Error("callback metadata write failed");
    });

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining(
          "Failed to persist action callback history",
        ),
      }),
    );
  });

  it("fails closed when callback durability metadata contradicts storage", async () => {
    const transientId = stringToUuid("transient-callback-response") as UUID;
    const { ctx, record, state } = createCtx(
      createPersistedCallbackMessageService(transientId),
    );
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockResolvedValueOnce([]);
    runtime.updateMemory = vi.fn(async () => true);
    vi.mocked(persistAssistantConversationMemory).mockClear();

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining(
          "Failed to persist action callback history",
        ),
      }),
    );
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it("fails closed when the callback target is owned by another agent", async () => {
    const responseId = stringToUuid("wrong-agent-id-response") as UUID;
    const { ctx, record, state } = createCtx(
      createPersistedCallbackMessageService(responseId),
    );
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockResolvedValueOnce([
      {
        id: responseId,
        entityId: AGENT_ID,
        agentId: stringToUuid("different-agent"),
        roomId: ROOM_ID,
        content: { text: "Calendar is ready." },
        createdAt: Date.now(),
      },
    ]);
    runtime.updateMemory = vi.fn(async () => true);
    vi.mocked(persistAssistantConversationMemory).mockClear();

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads.some((payload) => payload.type === "done")).toBe(false);
    expect(payloads).toContainEqual(
      expect.objectContaining({
        type: "error",
        message: expect.stringContaining(
          "Failed to persist action callback history",
        ),
      }),
    );
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it.each([
    [
      "stream",
      "absent from storage",
      "/api/conversations/conv-1/messages/stream",
      stringToUuid("transient-final-stream"),
    ],
    [
      "json",
      "absent from storage",
      "/api/conversations/conv-1/messages",
      stringToUuid("transient-final-json"),
    ],
    [
      "stream",
      "missing",
      "/api/conversations/conv-1/messages/stream",
      undefined,
    ],
    ["json", "missing", "/api/conversations/conv-1/messages", undefined],
  ] as const)(
    "%s: a final response whose id is %s cannot borrow an older same-text persisted id",
    async (mode, _idState, pathname, transientFinalId) => {
      const persistedEarlyId = stringToUuid(`persisted-early-${mode}`) as UUID;
      const { ctx, record, state } = createCtx(
        createMixedPersistedTransientMessageService(
          persistedEarlyId,
          transientFinalId,
        ),
      );
      const runtime = state.runtime;
      if (!runtime) throw new Error("runtime fixture missing");
      let routeOwnedMemory:
        | {
            id: UUID;
            entityId: UUID;
            agentId: UUID;
            roomId: UUID;
            content: { text: string };
            createdAt: number;
          }
        | undefined;
      vi.mocked(persistAssistantConversationMemory).mockImplementationOnce(
        async (
          callbackRuntime,
          roomId,
          content,
          _channelType,
          _dedupeSinceMs,
          memoryId,
        ) => {
          const persistedId =
            memoryId ?? stringToUuid(`route-persisted-${mode}`);
          routeOwnedMemory = {
            id: persistedId,
            entityId: callbackRuntime.agentId,
            agentId: callbackRuntime.agentId,
            roomId,
            content: {
              text:
                typeof content === "string"
                  ? content
                  : String(content.text ?? ""),
            },
            createdAt: Date.now(),
          };
          return routeOwnedMemory as never;
        },
      );
      vi.mocked(runtime.getMemoriesByIds).mockImplementation(async (ids) => {
        const rows = [];
        if (ids.includes(persistedEarlyId)) {
          rows.push({
            id: persistedEarlyId,
            entityId: AGENT_ID,
            agentId: AGENT_ID,
            roomId: ROOM_ID,
            content: { text: "Final answer." },
            createdAt: Date.now() - 1,
          });
        }
        if (routeOwnedMemory && ids.includes(routeOwnedMemory.id)) {
          rows.push(routeOwnedMemory);
        }
        return rows as never;
      });
      const updateMemory = vi.fn(async () => true);
      runtime.updateMemory = updateMemory;
      let jsonPayload: Record<string, unknown> | undefined;
      if (mode === "json") {
        ctx.pathname = pathname;
        ctx.json = vi.fn((_res, payload) => {
          jsonPayload = payload as Record<string, unknown>;
        });
      }

      await handleConversationRoutes(ctx);

      const terminal =
        mode === "stream"
          ? parseSsePayloads(record.writes).find(
              (payload) => payload.type === "done",
            )
          : jsonPayload;
      const messageId = terminal?.messageId;
      expect(terminal).toMatchObject({ messageId });
      if (mode === "stream") {
        expect(terminal).toMatchObject({ fullText: "Final answer." });
      } else {
        expect(terminal).toMatchObject({ text: "Final answer." });
      }
      expect(typeof messageId).toBe("string");
      expect(messageId).not.toBe(persistedEarlyId);
      expect(messageId).not.toBe(transientFinalId);
      expect(routeOwnedMemory?.id).toBe(messageId);
      expect(updateMemory).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["wrong room", stringToUuid("other-room"), AGENT_ID, AGENT_ID],
    ["wrong assistant entity", ROOM_ID, stringToUuid("other-agent"), AGENT_ID],
    ["wrong assistant agent", ROOM_ID, AGENT_ID, stringToUuid("other-agent")],
  ] as const)(
    "refuses to write callback history to an exact target in the %s",
    async (_label, roomId, entityId, agentId) => {
      const targetId = stringToUuid("callback-target") as UUID;
      const { state } = createCtx();
      const runtime = state.runtime;
      if (!runtime) throw new Error("runtime fixture missing");
      vi.mocked(runtime.getMemoriesByIds).mockResolvedValueOnce([
        {
          id: targetId,
          entityId,
          agentId,
          roomId,
          content: { text: "Some other turn." },
          createdAt: Date.now(),
        },
      ]);
      const updateMemory = vi.fn(async () => true);
      runtime.updateMemory = updateMemory;

      await expect(
        persistRecentAssistantActionCallbackHistory(
          runtime,
          ROOM_ID,
          ["VIEWS"],
          Date.now(),
          targetId,
        ),
      ).rejects.toThrow("Failed to persist action callback history");
      expect(updateMemory).not.toHaveBeenCalled();
    },
  );

  it("surfaces an exact callback-history update failure before terminal delivery", async () => {
    const targetId = stringToUuid("callback-update-failure") as UUID;
    const { state } = createCtx();
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.getMemoriesByIds).mockResolvedValueOnce([
      {
        id: targetId,
        entityId: AGENT_ID,
        agentId: AGENT_ID,
        roomId: ROOM_ID,
        content: { text: "Calendar is ready." },
        createdAt: Date.now(),
      },
    ]);
    runtime.updateMemory = vi.fn(async () => {
      throw new Error("callback metadata write failed");
    });

    await expect(
      persistRecentAssistantActionCallbackHistory(
        runtime,
        ROOM_ID,
        ["VIEWS"],
        Date.now(),
        targetId,
      ),
    ).rejects.toThrow("Failed to persist action callback history");
  });

  it("marks intentionally transient replies without inventing a durable id", async () => {
    const { ctx, record } = createCtx(createEphemeralReplyMessageService());

    await handleConversationRoutes(ctx);

    const done = parseSsePayloads(record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(done).toMatchObject({
      type: "done",
      fullText: "Temporary provider failure.",
      assistantEphemeral: true,
      userMessageId: stringToUuid("stream-contract-user-msg-store"),
      failureKind: "rate_limited",
    });
    expect(done).not.toHaveProperty("messageId");
    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
  });

  it("delivers a post-SSE-init failure as a structured SSE error frame, not an HTTP error", async () => {
    const { ctx, record, useModel } = createCtx();
    // First failure point past the SSE init: storing the user message.
    vi.mocked(persistConversationMemory).mockRejectedValueOnce(
      new Error("db write failed"),
    );

    await handleConversationRoutes(ctx);

    // Headers were already flushed as SSE — the failure may not rewrite them.
    expect(record.headers.status).toBe("200");
    expect(record.headers["Content-Type"]).toBe("text/event-stream");

    const payloads = parseSsePayloads(record.writes);
    expect(payloads[0]).toMatchObject({ type: "status", kind: "thinking" });
    const errorFrame = payloads.find((payload) => payload.type === "error");
    expect(errorFrame).toBeDefined();
    expect(String(errorFrame?.message)).toContain("db write failed");
    // The turn never reached the model, the stream was closed, and the
    // HTTP-mode error helper was never used.
    expect(useModel).not.toHaveBeenCalled();
    expect(record.ended).toBe(true);
    expect(record.writes.join("")).not.toContain("error 500");
  });

  it("fails a streaming turn immediately when runtime capability is absent", async () => {
    const { ctx, record, state, useModel } = createCtx();
    state.runtime = null;

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    expect(payloads).toContainEqual({
      type: "error",
      message: "Agent is not running",
    });
    expect(useModel).not.toHaveBeenCalled();
    expect(record.ended).toBe(true);
  });

  it("keeps pre-SSE validation failures on plain HTTP (conversation not found → 404)", async () => {
    const { ctx, record } = createCtx();
    const brokenCtx = {
      ...ctx,
      pathname: "/api/conversations/missing-conv/messages/stream",
    } as ConversationRouteContext;

    await handleConversationRoutes(brokenCtx);

    // The ctx error helper writes `error <status>: <message>` — no SSE header.
    expect(record.headers["Content-Type"]).toBeUndefined();
    expect(record.writes.join("")).toContain("error 404");
  });

  it("ships bare deltas (no per-token fullText) when the client negotiates delta-v2, and reconstructs the done text", async () => {
    requestStreamProtocol = "delta-v2";
    const { ctx, record } = createCtx();

    await handleConversationRoutes(ctx);

    const payloads = parseSsePayloads(record.writes);
    const tokens = payloads.filter((payload) => payload.type === "token");
    // These four tokens total ~27 chars — well under the 2048-byte snapshot
    // floor — so EVERY token frame is a pure delta with no fullText key.
    expect(tokens.map((payload) => payload.text)).toEqual(TOKENS);
    for (const token of tokens) {
      expect(token).not.toHaveProperty("fullText");
    }
    // Client semantics (append delta when no fullText) reconstruct the reply.
    const reconstructed = tokens.reduce(
      (acc, token) => acc + String(token.text ?? ""),
      "",
    );
    expect(reconstructed).toBe(FINAL_TEXT);
    // The terminal done frame is the full-text authority in delta framing too.
    const done = payloads.find((payload) => payload.type === "done");
    expect(done).toMatchObject({ type: "done", fullText: FINAL_TEXT });
  });

  it("emits a mid-stream structured rewrite as a fullText-only snapshot frame under delta-v2 (cumulative fullText under legacy)", async () => {
    // "Hello wrld" then "Hello world" is a non-append revise: the route's
    // onStreamChunk → appendIncomingText resolves it to a snapshot replace, so
    // onSnapshot fires with the corrected text.
    const messageService = createChunkPlanMessageService(
      [
        { chunk: "Hello wrld", accumulated: "Hello wrld" },
        { chunk: "Hello world", accumulated: "Hello world" },
      ],
      "Hello world",
      "corrected a typo mid-stream",
    );

    // Delta framing: the append is a bare delta; the revise is a fullText-only
    // snapshot frame (authoritative replace, no `text`).
    requestStreamProtocol = "delta-v2";
    const delta = createCtx(messageService);
    await handleConversationRoutes(delta.ctx);
    const deltaTokens = parseSsePayloads(delta.record.writes).filter(
      (payload) => payload.type === "token",
    );
    expect(deltaTokens).toEqual([
      { type: "token", text: "Hello wrld" },
      { type: "token", fullText: "Hello world" },
    ]);
    // Replay with client semantics (append text; replace on fullText).
    const deltaReconstructed = deltaTokens.reduce((acc, token) => {
      if (typeof token.fullText === "string") return token.fullText;
      return acc + String(token.text ?? "");
    }, "");
    expect(deltaReconstructed).toBe("Hello world");
    const deltaDone = parseSsePayloads(delta.record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(deltaDone).toMatchObject({ fullText: "Hello world" });

    // Legacy framing: BOTH frames carry cumulative fullText (byte-identical to
    // the historical writer), so an un-negotiated client stays correct.
    requestStreamProtocol = undefined;
    const legacy = createCtx(
      createChunkPlanMessageService(
        [
          { chunk: "Hello wrld", accumulated: "Hello wrld" },
          { chunk: "Hello world", accumulated: "Hello world" },
        ],
        "Hello world",
        "corrected a typo mid-stream",
      ),
    );
    await handleConversationRoutes(legacy.ctx);
    const legacyTokens = parseSsePayloads(legacy.record.writes).filter(
      (payload) => payload.type === "token",
    );
    expect(legacyTokens).toEqual([
      { type: "token", text: "Hello wrld", fullText: "Hello wrld" },
      { type: "token", text: "Hello world", fullText: "Hello world" },
    ]);
  });
});
