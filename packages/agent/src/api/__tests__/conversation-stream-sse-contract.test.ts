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
    persistAssistantConversationMemory: vi.fn(async () => null),
    hasRecentVisibleAssistantMemorySince: vi.fn(async () => false),
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
import { handleConversationRoutes } from "../conversation-routes.ts";

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
        onStreamChunk?: (chunk: string) => Promise<void> | void;
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
  chunks: string[],
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
        onStreamChunk?: (chunk: string) => Promise<void> | void;
      },
    ) {
      for (const chunk of chunks) {
        await Promise.resolve();
        await options?.onStreamChunk?.(chunk);
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

function createPersistedCallbackMessageService(
  messageId: UUID,
): NonNullable<AgentRuntime["messageService"]> {
  const text = "Calendar is ready.";
  return {
    async handleMessage(_runtime, _message, callback) {
      await callback?.({ text });
      return {
        didRespond: true,
        responseContent: { text },
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
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn(() => null),
    drainChatPreHandlers: vi.fn(async () => null),
    createLogs: vi.fn(async () => undefined),
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
    // The terminal `done` frame carries the persisted assistant message id
    // (pre-minted before the deferred DB insert), and the SAME id is handed to
    // the persistence layer — the contract the client relies on to swap its
    // streamed temp-resp-* bubble so the proactive-message WS echo reconciles
    // by id instead of appending a duplicate bubble.
    const doneMessageId = payloads[doneIndex].messageId;
    expect(typeof doneMessageId).toBe("string");
    const persistedCall = vi
      .mocked(persistAssistantConversationMemory)
      .mock.calls.find((call) => call[5] === doneMessageId);
    expect(persistedCall).toBeDefined();
    expect(persistedCall?.[1]).toBe(ROOM_ID);
    expect(persistedCall?.[2]).toMatchObject({ text: FINAL_TEXT });
    expect(persistedCall?.[3]).toBe(ChannelType.DM);
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

  it("uses this turn's exact persisted response id instead of a room-latest guess", async () => {
    const responseId = stringToUuid("persisted-callback-response") as UUID;
    const { ctx, record } = createCtx(
      createPersistedCallbackMessageService(responseId),
    );
    vi.mocked(persistAssistantConversationMemory).mockClear();

    await handleConversationRoutes(ctx);

    const done = parseSsePayloads(record.writes).find(
      (payload) => payload.type === "done",
    );
    expect(done).toMatchObject({
      type: "done",
      fullText: "Calendar is ready.",
      messageId: responseId,
    });
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
      ["Hello wrld", "Hello world"],
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
        ["Hello wrld", "Hello world"],
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
