/**
 * Route-level wiring coverage for the HTTP chat idempotency guard on the
 * dedicated-agent conversation endpoints (`POST /api/conversations/:id/messages`
 * and its `/stream` twin). The pure decision function is pinned in
 * `chat-idempotency.test.ts`; these tests prove the routes actually consult it:
 * a first send runs the LLM turn, a retry carrying the SAME `clientMessageId`
 * within the TTL is suppressed (no second turn, no second persisted memory) and
 * — when the first attempt's assistant reply already persisted — answers with
 * THAT reply instead of an empty ignored turn; a retry landing while the
 * original is still mid-turn (nothing persisted yet) keeps the empty ignored
 * shape; and a send WITHOUT an idempotency key behaves exactly as before (no
 * dedupe).
 *
 * Deliberately mock-free at the module level (no `vi.mock`): the real route
 * handlers, real `chat-routes` helpers, and the real dedupe cache run end to
 * end; only the runtime seam (message service + memory adapter) is stubbed, so
 * `messageService.handleMessage` call counts are the ground truth for "an LLM
 * turn ran" and `runtime.createMemory` counts for "a memory was persisted".
 *
 * The modules under test are loaded dynamically after `vi.resetModules()`
 * rather than via static imports: this package's vmForks pool shares the
 * module cache across test files in a worker, so a sibling suite that
 * `vi.mock`s `chat-routes.ts` would otherwise leak its mocked graph into this
 * file (and vice versa) depending on execution order. The fresh graph makes
 * this suite order-independent and guarantees the REAL guard + routes run.
 */

import http from "node:http";
import type { AgentRuntime, Memory } from "@elizaos/core";
import { logger, stringToUuid, type UUID } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  ConversationRouteContext,
  ConversationRouteState,
} from "../conversation-routes.ts";

let handleConversationRoutes: typeof import("../conversation-routes.ts")["handleConversationRoutes"];
let resetChatDedupe: () => void;
let markChatMessageSeen: typeof import("../chat-routes.ts")["isDuplicateChatMessage"];
let setChatOutcome: typeof import("../chat-routes.ts")["setChatMessageIdOutcome"];

beforeAll(async () => {
  vi.resetModules();
  const chatRoutes = await import("../chat-routes.ts");
  resetChatDedupe = chatRoutes.__resetChatDedupeForTests;
  markChatMessageSeen = chatRoutes.isDuplicateChatMessage;
  setChatOutcome = chatRoutes.setChatMessageIdOutcome;
  ({ handleConversationRoutes } = await import("../conversation-routes.ts"));
});

// Symmetric hygiene: drop this suite's real module graph from the shared
// worker cache so a later file's `vi.mock` factories apply to fresh imports
// instead of silently hitting our unmocked instances.
afterAll(() => {
  vi.resetModules();
});

const AGENT_ID = stringToUuid("agent-1") as UUID;
const USER_ID = stringToUuid("user-1") as UUID;
const ROOM_ID = stringToUuid("room-1") as UUID;

const STREAM_PATH = "/api/conversations/conv-1/messages/stream";
const SEND_PATH = "/api/conversations/conv-1/messages";
const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;
const RECONNECT_WAIT_TIMEOUT_MS = 30_000;
const RECONNECT_SIGNAL_DEBOUNCE_MS = 400;

interface MockResponseRecord {
  writes: string[];
  ended: boolean;
}

function createMockRes(): {
  res: http.ServerResponse;
  record: MockResponseRecord;
} {
  const record: MockResponseRecord = { writes: [], ended: false };
  const res = {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    write: vi.fn((chunk: string | Buffer) => {
      record.writes.push(
        typeof chunk === "string" ? chunk : chunk.toString("utf-8"),
      );
      return true;
    }),
    end: vi.fn(() => {
      record.ended = true;
    }),
    writableEnded: false,
  } as unknown as http.ServerResponse;
  return { res, record };
}

interface TestHarness {
  state: ConversationRouteState;
  handleMessage: ReturnType<typeof vi.fn>;
  createMemory: ReturnType<typeof vi.fn>;
  storedMemories: Memory[];
}

/** Real-route harness: the runtime stub streams one "ok" chunk per turn via
 *  the message service, so the real `generateChatResponse` pipeline (status →
 *  token → done framing, persistence ordering) runs unmodified. Persisted
 *  memories are retained and served back through `getMemories`, so the dupe
 *  branches' persisted-first-reply lookup reads the real write path's output. */
function createHarness(): TestHarness {
  const handleMessage = vi.fn(
    async (
      _runtime: unknown,
      _message: unknown,
      _callback: unknown,
      options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
    ) => {
      await Promise.resolve();
      await options?.onStreamChunk?.("ok");
      return {
        didRespond: true,
        responseContent: { text: "ok" },
        responseMessages: [],
      };
    },
  );
  const storedMemories: Memory[] = [];
  const worlds = new Map<
    UUID,
    { id: UUID; agentId: UUID; metadata: Record<string, unknown> }
  >();
  const createMemory = vi.fn(async (memory: Memory) => {
    if (memory.id && storedMemories.some((stored) => stored.id === memory.id)) {
      throw new Error("duplicate unique constraint: messages.id");
    }
    storedMemories.push(memory);
    return memory.id ?? stringToUuid("created-memory");
  });
  const updateMemory = vi.fn(async (memory: Partial<Memory> & { id: UUID }) => {
    const index = storedMemories.findIndex((stored) => stored.id === memory.id);
    if (index < 0) throw new Error("memory not found");
    storedMemories[index] = { ...storedMemories[index], ...memory };
    return true;
  });
  const runtime = {
    agentId: AGENT_ID,
    character: {
      name: "Test Agent",
      system: "System prompt",
      settings: { model: "test/model" },
    },
    actions: [],
    plugins: [],
    logger,
    emitEvent: vi.fn(async () => undefined),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    drainChatPreHandlers: vi.fn(async () => null),
    messageService: {
      handleMessage,
      shouldRespond: () => ({
        shouldRespond: true,
        skipEvaluation: true,
        reason: "idempotency-test",
      }),
      deleteMessage: async () => undefined,
      clearChannel: async () => undefined,
    },
    createMemory,
    updateMemory,
    createLogs: vi.fn(async () => undefined),
    getMemories: vi.fn(async () => storedMemories),
    getMemoriesByIds: vi.fn(async (ids: UUID[]) =>
      storedMemories.filter(
        (memory) => memory.id && ids.includes(memory.id as UUID),
      ),
    ),
    ensureConnection: vi.fn(async (input: { worldId?: UUID }) => {
      if (!input.worldId) throw new Error("worldId is required");
      if (!worlds.has(input.worldId)) {
        worlds.set(input.worldId, {
          id: input.worldId,
          agentId: AGENT_ID,
          metadata: {},
        });
      }
    }),
    updateWorld: vi.fn(async () => undefined),
    getWorld: vi.fn(async (worldId: UUID) => worlds.get(worldId) ?? null),
    getRoom: vi.fn(async () => null),
    reportError: vi.fn(),
    adapter: {} as never,
  } satisfies Partial<AgentRuntime> & Record<string, unknown>;

  const conv = {
    id: "conv-1",
    title: "Test conv",
    roomId: ROOM_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const state = {
    runtime: runtime as never,
    config: { user: { name: "tester" } } as never,
    agentName: "Test Agent",
    adminEntityId: USER_ID,
    chatUserId: USER_ID,
    logBuffer: [],
    conversations: new Map([[conv.id, conv]]),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set<string>(),
    broadcastWs: null,
  } as unknown as ConversationRouteState;

  return { state, handleMessage, createMemory, storedMemories };
}

function createReq(method: string, url: string): http.IncomingMessage {
  return Object.assign(new http.IncomingMessage(null as never), {
    method,
    url,
    headers: {},
  }) as http.IncomingMessage;
}

interface CapturedJson {
  payload: unknown;
}

/** Drive one request through the real route handler and await its durable terminal result. */
async function runRoute(
  method: string,
  pathname: string,
  state: ConversationRouteState,
  body: Record<string, unknown>,
  duringRequest?: (req: http.IncomingMessage) => Promise<void> | void,
): Promise<{ record: MockResponseRecord; captured: CapturedJson }> {
  const { res, record } = createMockRes();
  const req = createReq(method, pathname);
  const captured: CapturedJson = { payload: undefined };
  const ctx = {
    req,
    res,
    method,
    pathname,
    state,
    readJsonBody: vi.fn(async () => body),
    json: vi.fn((_res: unknown, payload: unknown) => {
      captured.payload = payload;
    }),
    error: vi.fn(
      (response: http.ServerResponse, message: string, status?: number) => {
        response.write(`error ${status}: ${message}`);
        response.end();
      },
    ),
  } as unknown as ConversationRouteContext;

  const done = handleConversationRoutes(ctx);
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
  await duringRequest?.(req);
  // Bound the wait so a route that stalls (e.g. a regression that never emits
  // the terminal frame) fails this test promptly instead of eating the full
  // 120s per-test timeout.
  await Promise.race([
    done,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("conversation route did not settle within 15s")),
        15_000,
      ).unref?.(),
    ),
  ]);
  // The streaming handler defers assistant persistence past res.end(); flush it.
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
  return { record, captured };
}

function parseDataFrames(record: MockResponseRecord): Array<{
  type: string;
  fullText?: string;
  messageId?: string;
  agentName?: string;
  transcriptVisibility?: "internal";
  thought?: string;
  usage?: unknown;
  actionResults?: unknown;
  failureKind?: string;
  accountConnect?: unknown;
  localInference?: unknown;
  noResponseReason?: "ignored";
}> {
  return record.writes
    .join("")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as {
          type: string;
          fullText?: string;
          messageId?: string;
          agentName?: string;
          transcriptVisibility?: "internal";
          thought?: string;
          usage?: unknown;
          actionResults?: unknown;
          failureKind?: string;
          accountConnect?: unknown;
          localInference?: unknown;
          noResponseReason?: "ignored";
        },
    );
}

describe("conversation-route chat idempotency wiring", () => {
  beforeEach(() => {
    resetChatDedupe();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("SSE: first send runs the turn; a retry after delivery returns the persisted first reply", async () => {
    const { state, handleMessage, createMemory } = createHarness();
    const body = { text: "hello", clientMessageId: "sse-retry-1" };

    const first = await runRoute("POST", STREAM_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const persistsAfterFirst = createMemory.mock.calls.length;
    expect(persistsAfterFirst).toBeGreaterThan(0);
    const firstDone = parseDataFrames(first.record).find(
      (f) => f.type === "done",
    );
    expect(firstDone?.fullText).toBe("ok");

    // Network-blip auto-retry: same conversation, same clientMessageId.
    const second = await runRoute("POST", STREAM_PATH, state, body);
    // No second LLM turn, no additional persisted memories (user or assistant).
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledTimes(persistsAfterFirst);
    // The first attempt's reply already persisted, so the retry's terminal
    // frame carries IT — the retry delivers the original outcome instead of
    // an empty turn the client must repair from history.
    const frames = parseDataFrames(second.record);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "done", fullText: "ok" });
    expect(second.record.ended).toBe(true);
  });

  it("replays the complete terminal contract with explicit stream and JSON mappings", async () => {
    const { state, handleMessage } = createHarness();
    const clientMessageId = "terminal-contract-retry";
    expect(markChatMessageSeen(ROOM_ID, clientMessageId)).toBe(false);
    setChatOutcome(ROOM_ID, clientMessageId, {
      text: "",
      agentName: "Original Agent",
      messageId: stringToUuid("terminal-contract-reply"),
      transcriptVisibility: "internal",
      thought: "private reasoning",
      usage: {
        promptTokens: 7,
        completionTokens: 3,
        totalTokens: 10,
        isEstimated: false,
        llmCalls: 1,
      },
      actionResults: [{ actionName: "VIEWS", success: true }],
      failureKind: "no_provider",
      accountConnect: { providers: ["openai-codex"] },
      localInference: { status: "ready" },
    });

    const stream = await runRoute("POST", STREAM_PATH, state, {
      text: "ignored retry payload",
      clientMessageId,
    });
    expect(parseDataFrames(stream.record)).toEqual([
      expect.objectContaining({
        type: "done",
        fullText: "",
        agentName: "Original Agent",
        messageId: stringToUuid("terminal-contract-reply"),
        transcriptVisibility: "internal",
        thought: "private reasoning",
        usage: expect.objectContaining({ totalTokens: 10 }),
        actionResults: [{ actionName: "VIEWS", success: true }],
        failureKind: "no_provider",
        accountConnect: { providers: ["openai-codex"] },
        localInference: { status: "ready" },
      }),
    ]);

    const jsonRetry = await runRoute("POST", SEND_PATH, state, {
      text: "ignored retry payload",
      clientMessageId,
    });
    expect(jsonRetry.captured.payload).toEqual({
      text: "",
      agentName: "Original Agent",
      messageId: stringToUuid("terminal-contract-reply"),
      transcriptVisibility: "internal",
      actionResults: [{ actionName: "VIEWS", success: true }],
      failureKind: "no_provider",
      accountConnect: { providers: ["openai-codex"] },
      localInference: { status: "ready" },
    });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it("SSE: interleaved turns replay the outcome bound to the retried key", async () => {
    const { state, handleMessage, storedMemories } = createHarness();
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    handleMessage.mockImplementation(
      async (
        _runtime: unknown,
        message: { content?: { text?: string } },
        _callback: unknown,
        options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
      ) => {
        const prompt = message.content?.text ?? "";
        const isA = prompt === "turn a";
        await (isA ? gateA : gateB);
        const text = isA ? "reply a" : "reply b";
        await options?.onStreamChunk?.(text);
        return {
          didRespond: true,
          responseContent: { text },
          responseMessages: [],
        };
      },
    );

    const turnA = runRoute("POST", STREAM_PATH, state, {
      text: "turn a",
      clientMessageId: "interleaved-a",
    });
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(1));
    const turnB = runRoute("POST", STREAM_PATH, state, {
      text: "turn b",
      clientMessageId: "interleaved-b",
    });
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(2));

    releaseA?.();
    const first = await turnA;
    releaseB?.();
    const second = await turnB;
    const firstDone = parseDataFrames(first.record).find(
      (frame) => frame.type === "done",
    );
    const secondDone = parseDataFrames(second.record).find(
      (frame) => frame.type === "done",
    );
    expect(firstDone).toMatchObject({ fullText: "reply a" });
    expect(secondDone).toMatchObject({ fullText: "reply b" });

    const retry = await runRoute("POST", STREAM_PATH, state, {
      text: "turn a",
      clientMessageId: "interleaved-a",
    });
    const retryDone = parseDataFrames(retry.record).find(
      (frame) => frame.type === "done",
    );
    expect(retryDone).toMatchObject({
      fullText: "reply a",
      messageId: firstDone?.messageId,
    });
    expect(retryDone?.messageId).not.toBe(secondDone?.messageId);
    expect(
      storedMemories.some(
        (memory) =>
          memory.id === firstDone?.messageId &&
          (memory.content as { text?: string }).text === "reply a",
      ),
    ).toBe(true);
  });

  it("SSE: rapid same-text turns persist both advertised ids", async () => {
    const { state, storedMemories } = createHarness();
    const first = await runRoute("POST", STREAM_PATH, state, {
      text: "same",
      clientMessageId: "same-a",
    });
    const second = await runRoute("POST", STREAM_PATH, state, {
      text: "same",
      clientMessageId: "same-b",
    });
    const doneFrames = [first, second].map(({ record }) =>
      parseDataFrames(record).find((frame) => frame.type === "done"),
    );

    expect(doneFrames[0]?.messageId).toBeTruthy();
    expect(doneFrames[1]?.messageId).toBeTruthy();
    expect(doneFrames[0]?.messageId).not.toBe(doneFrames[1]?.messageId);
    for (const done of doneFrames) {
      expect(
        storedMemories.some(
          (memory) =>
            memory.id === done?.messageId &&
            (memory.content as { text?: string }).text === "ok",
        ),
      ).toBe(true);
    }
  });

  it("SSE: normalizes the message-service row in place instead of inserting a duplicate", async () => {
    const { state, handleMessage, storedMemories } = createHarness();
    const leakedPayload =
      '"RESPOND","contexts":["simple"],"replyText":"Normalized reply","candidateActionNames":[]';
    const persistedId = stringToUuid("normalized-existing-assistant");
    handleMessage.mockImplementationOnce(
      async (
        runtime: AgentRuntime,
        message: Memory,
        _callback: unknown,
        options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
      ) => {
        const persisted: Memory = {
          id: persistedId,
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId: message.roomId,
          content: { text: leakedPayload },
        };
        await runtime.createMemory(persisted, "messages");
        await options?.onStreamChunk?.(leakedPayload);
        return {
          didRespond: true,
          responseContent: { text: leakedPayload },
          responseMessages: [persisted],
          persistedResponseMessageIds: [persistedId],
        };
      },
    );

    const response = await runRoute("POST", STREAM_PATH, state, {
      text: "normalize it",
      clientMessageId: "normalize-existing-1",
    });
    const done = parseDataFrames(response.record).find(
      (frame) => frame.type === "done",
    );
    const assistantRows = storedMemories.filter(
      (memory) => memory.entityId === AGENT_ID,
    );

    expect(done).toMatchObject({
      fullText: "Normalized reply",
      messageId: persistedId,
    });
    expect(assistantRows).toHaveLength(1);
    expect(assistantRows[0]).toMatchObject({
      id: persistedId,
      content: { text: "Normalized reply" },
    });
  });

  it("SSE: a dupe landing while the original is still mid-turn keeps the empty ignored shape", async () => {
    const { state, handleMessage } = createHarness();
    // Simulate the original request's arrival being recorded with its turn
    // still in flight: the idempotency key is seen, but no assistant reply has
    // persisted yet.
    expect(markChatMessageSeen(ROOM_ID, "sse-mid-turn-1")).toBe(false);

    const retry = await runRoute("POST", STREAM_PATH, state, {
      text: "hello",
      clientMessageId: "sse-mid-turn-1",
    });

    expect(handleMessage).not.toHaveBeenCalled();
    const frames = parseDataFrames(retry.record);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "done", fullText: "" });
    expect(retry.record.ended).toBe(true);
  });

  it("SSE: a slow reconnect retry after a long completed turn is still suppressed", async () => {
    const { state, handleMessage, createMemory } = createHarness();
    const body = { text: "hello", clientMessageId: "sse-long-retry-1" };
    const firstArrival = Date.now();
    const nowSpy = vi.spyOn(Date, "now");

    try {
      nowSpy.mockReturnValue(firstArrival);
      const first = await runRoute("POST", STREAM_PATH, state, body);
      expect(handleMessage).toHaveBeenCalledTimes(1);
      const persistsAfterFirst = createMemory.mock.calls.length;
      expect(persistsAfterFirst).toBeGreaterThan(0);
      const firstDone = parseDataFrames(first.record).find(
        (f) => f.type === "done",
      );
      expect(firstDone?.fullText).toBe("ok");

      nowSpy.mockReturnValue(
        firstArrival +
          DEFAULT_GENERATION_TIMEOUT_MS +
          RECONNECT_WAIT_TIMEOUT_MS +
          RECONNECT_SIGNAL_DEBOUNCE_MS,
      );
      const retry = await runRoute("POST", STREAM_PATH, state, body);

      expect(handleMessage).toHaveBeenCalledTimes(1);
      expect(createMemory).toHaveBeenCalledTimes(persistsAfterFirst);
      const retryFrames = parseDataFrames(retry.record);
      expect(retryFrames).toHaveLength(1);
      expect(retryFrames[0]).toMatchObject({ type: "done", fullText: "ok" });
      expect(retry.record.ended).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("SSE: a retry after a disconnect-ABORTED first attempt re-runs the turn (no dead air)", async () => {
    // The flagship blip-retry scenario the client was built for: iOS suspend
    // kills the socket, the server aborts generation (persisting no reply),
    // and the client resends the SAME clientMessageId on resume. The arrival-
    // keyed guard must be rolled back on the abort path or this retry is
    // suppressed into a silently eaten message.
    const { state, handleMessage, createMemory } = createHarness();
    const abortError = Object.assign(new Error("client disconnected"), {
      code: "TURN_ABORTED",
    });
    handleMessage.mockImplementationOnce(async () => {
      throw abortError;
    });
    const body = { text: "hello", clientMessageId: "sse-abort-retry-1" };

    const first = await runRoute("POST", STREAM_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    // Aborted turn: no assistant "done" payload with text was delivered.
    const firstDone = parseDataFrames(first.record).find(
      (f) => f.type === "done" && f.fullText === "ok",
    );
    expect(firstDone).toBeUndefined();

    // The auto-retry with the same id must RUN — it is not a duplicate of any
    // delivered outcome.
    const second = await runRoute("POST", STREAM_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(2);
    const secondDone = parseDataFrames(second.record).find(
      (f) => f.type === "done",
    );
    expect(secondDone?.fullText).toBe("ok");
    expect(createMemory.mock.calls.length).toBeGreaterThan(0);
  });

  it("SSE: a completed turn survives transport disconnect and the retry replays it", async () => {
    const { state, handleMessage, createMemory } = createHarness();
    let releaseTurn: (() => void) | undefined;
    const turnGate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    handleMessage.mockImplementationOnce(
      async (
        _runtime: unknown,
        _message: unknown,
        _callback: unknown,
        options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
      ) => {
        await options?.onStreamChunk?.("durable reply");
        await turnGate;
        return {
          didRespond: true,
          responseContent: { text: "durable reply" },
          responseMessages: [],
        };
      },
    );
    const body = {
      text: "finish even if my socket drops",
      clientMessageId: "disconnect-after-model-1",
    };

    await runRoute("POST", STREAM_PATH, state, body, async (req) => {
      expect(handleMessage).toHaveBeenCalledTimes(1);
      req.emit("aborted");
      releaseTurn?.();
    });
    const persistsAfterDisconnect = createMemory.mock.calls.length;
    expect(persistsAfterDisconnect).toBeGreaterThan(0);

    const retry = await runRoute("POST", STREAM_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledTimes(persistsAfterDisconnect);
    expect(parseDataFrames(retry.record)).toEqual([
      expect.objectContaining({
        type: "done",
        fullText: "durable reply",
        messageId: expect.any(String),
      }),
    ]);
  });

  it("SSE: terminal setup and persistence failures release the key for a real retry", async () => {
    const { state, handleMessage, createMemory, storedMemories } =
      createHarness();
    const body = { text: "retry me", clientMessageId: "terminal-retry-1" };
    const runtime = state.runtime;
    state.runtime = null;

    const unavailable = await runRoute("POST", STREAM_PATH, state, body);
    expect(
      parseDataFrames(unavailable.record).some(
        (frame) => frame.type === "error",
      ),
    ).toBe(true);

    state.runtime = runtime;
    const persistImpl = createMemory.getMockImplementation();
    if (!persistImpl)
      throw new Error("createMemory fixture lost implementation");
    let rejectAssistantWrites = true;
    createMemory.mockImplementation(async (memory: Memory) => {
      if (rejectAssistantWrites && memory.entityId === AGENT_ID) {
        throw new Error("assistant persistence unavailable");
      }
      return await (persistImpl as (value: Memory) => Promise<unknown>)(memory);
    });

    const persistenceFailure = await runRoute("POST", STREAM_PATH, state, body);
    expect(
      parseDataFrames(persistenceFailure.record).some(
        (frame) => frame.type === "error",
      ),
    ).toBe(true);
    rejectAssistantWrites = false;

    const recovered = await runRoute("POST", STREAM_PATH, state, body);
    const recoveredDone = parseDataFrames(recovered.record).find(
      (frame) => frame.type === "done",
    );
    expect(recoveredDone).toMatchObject({ fullText: "ok" });
    expect(recoveredDone?.messageId).toBeTruthy();
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(
      storedMemories.filter((memory) => memory.entityId === USER_ID),
    ).toHaveLength(1);
  });

  it("SSE: a room-initialization failure releases the key for recovery", async () => {
    const { state, handleMessage } = createHarness();
    const runtime = state.runtime;
    if (!runtime) throw new Error("runtime fixture missing");
    vi.mocked(runtime.ensureConnection).mockRejectedValueOnce(
      new Error("room setup unavailable"),
    );
    const body = { text: "retry room setup", clientMessageId: "room-retry-1" };

    const failed = await runRoute("POST", STREAM_PATH, state, body);
    expect(
      parseDataFrames(failed.record).some((frame) => frame.type === "error"),
    ).toBe(true);
    const recovered = await runRoute("POST", STREAM_PATH, state, body);

    expect(
      parseDataFrames(recovered.record).find((frame) => frame.type === "done"),
    ).toMatchObject({ fullText: "ok" });
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("SSE: a user-write failure releases the key for recovery", async () => {
    const { state, handleMessage, createMemory } = createHarness();
    createMemory.mockRejectedValueOnce(new Error("user write unavailable"));
    const body = { text: "retry user write", clientMessageId: "user-retry-1" };

    const failed = await runRoute("POST", STREAM_PATH, state, body);
    expect(
      parseDataFrames(failed.record).some((frame) => frame.type === "error"),
    ).toBe(true);
    const recovered = await runRoute("POST", STREAM_PATH, state, body);

    expect(
      parseDataFrames(recovered.record).find((frame) => frame.type === "done"),
    ).toMatchObject({ fullText: "ok" });
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a released key is retried with a different user payload", async () => {
    const { state, handleMessage, createMemory, storedMemories } =
      createHarness();
    const createImpl = createMemory.getMockImplementation();
    if (!createImpl)
      throw new Error("createMemory fixture lost implementation");
    let rejectAssistantWrite = true;
    createMemory.mockImplementation(async (memory: Memory) => {
      if (rejectAssistantWrite && memory.entityId === AGENT_ID) {
        throw new Error("assistant persistence unavailable");
      }
      return await (createImpl as (value: Memory) => Promise<unknown>)(memory);
    });
    const clientMessageId = "changed-payload-retry";

    const failed = await runRoute("POST", STREAM_PATH, state, {
      text: "original payload",
      clientMessageId,
    });
    expect(
      parseDataFrames(failed.record).some((frame) => frame.type === "error"),
    ).toBe(true);
    expect(handleMessage).toHaveBeenCalledTimes(1);

    rejectAssistantWrite = false;
    const conflicting = await runRoute("POST", STREAM_PATH, state, {
      text: "different payload",
      clientMessageId,
    });
    expect(
      parseDataFrames(conflicting.record).some(
        (frame) => frame.type === "error",
      ),
    ).toBe(true);
    expect(handleMessage).toHaveBeenCalledTimes(1);

    const recovered = await runRoute("POST", STREAM_PATH, state, {
      text: "original payload",
      clientMessageId,
    });
    expect(
      parseDataFrames(recovered.record).find((frame) => frame.type === "done"),
    ).toMatchObject({ fullText: "ok" });
    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(
      storedMemories.filter((memory) => memory.entityId === USER_ID),
    ).toHaveLength(1);
  });

  it("SSE: a neighboring successful turn cannot suppress this turn's failure fallback", async () => {
    const { state, handleMessage, storedMemories } = createHarness();
    let releaseFailedTurn: (() => void) | undefined;
    const failedTurnGate = new Promise<void>((resolve) => {
      releaseFailedTurn = resolve;
    });
    handleMessage.mockImplementation(
      async (
        _runtime: unknown,
        message: { content?: { text?: string } },
        _callback: unknown,
        options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
      ) => {
        if (message.content?.text === "turn a fails") {
          await failedTurnGate;
          throw new Error("turn a provider failure");
        }
        await options?.onStreamChunk?.("turn b reply");
        return {
          didRespond: true,
          responseContent: { text: "turn b reply" },
          responseMessages: [],
        };
      },
    );

    const failedTurn = runRoute("POST", STREAM_PATH, state, {
      text: "turn a fails",
      clientMessageId: "interleaved-failed-a",
    });
    await vi.waitFor(() => expect(handleMessage).toHaveBeenCalledTimes(1));
    const successfulTurn = await runRoute("POST", STREAM_PATH, state, {
      text: "turn b succeeds",
      clientMessageId: "interleaved-success-b",
    });
    releaseFailedTurn?.();
    const failedResult = await failedTurn;

    const successfulDone = parseDataFrames(successfulTurn.record).find(
      (frame) => frame.type === "done",
    );
    const failedDone = parseDataFrames(failedResult.record).find(
      (frame) => frame.type === "done",
    );
    expect(successfulDone).toMatchObject({ fullText: "turn b reply" });
    expect(failedDone?.noResponseReason).toBeUndefined();
    expect(failedDone?.fullText).toBeTruthy();
    expect(failedDone?.messageId).toBeTruthy();
    expect(failedDone?.messageId).not.toBe(successfulDone?.messageId);
    expect(
      storedMemories.some(
        (memory) =>
          memory.id === failedDone?.messageId &&
          (memory.content as { text?: string }).text === failedDone?.fullText,
      ),
    ).toBe(true);

    const retry = await runRoute("POST", STREAM_PATH, state, {
      text: "turn a fails",
      clientMessageId: "interleaved-failed-a",
    });
    expect(
      parseDataFrames(retry.record).find((frame) => frame.type === "done"),
    ).toMatchObject({
      fullText: failedDone?.fullText,
      messageId: failedDone?.messageId,
    });
    expect(handleMessage).toHaveBeenCalledTimes(2);
  });

  it("SSE: rapid identical post-token failures each persist and advertise their own row", async () => {
    const { state, handleMessage, storedMemories } = createHarness();
    handleMessage.mockImplementation(
      async (
        _runtime: unknown,
        _message: unknown,
        _callback: unknown,
        options?: { onStreamChunk?: (chunk: string) => Promise<void> | void },
      ) => {
        await options?.onStreamChunk?.("partial reply");
        throw new Error("planner failed after token");
      },
    );

    const first = await runRoute("POST", STREAM_PATH, state, {
      text: "same",
      clientMessageId: "post-token-a",
    });
    const second = await runRoute("POST", STREAM_PATH, state, {
      text: "same",
      clientMessageId: "post-token-b",
    });
    const doneFrames = [first, second].map(({ record }) =>
      parseDataFrames(record).find((frame) => frame.type === "done"),
    );

    expect(doneFrames[0]).toMatchObject({ fullText: "partial reply" });
    expect(doneFrames[1]).toMatchObject({ fullText: "partial reply" });
    expect(doneFrames[0]?.messageId).toBeTruthy();
    expect(doneFrames[1]?.messageId).toBeTruthy();
    expect(doneFrames[0]?.messageId).not.toBe(doneFrames[1]?.messageId);
    for (const done of doneFrames) {
      expect(
        storedMemories.some(
          (memory) =>
            memory.id === done?.messageId &&
            (memory.content as { text?: string }).text === "partial reply",
        ),
      ).toBe(true);
    }
  });

  it("rapid identical wallet guidance persists distinct rows on stream and JSON routes", async () => {
    const { state, handleMessage, storedMemories } = createHarness();
    const requests = [
      [STREAM_PATH, "wallet-stream-a"],
      [STREAM_PATH, "wallet-stream-b"],
      [SEND_PATH, "wallet-json-a"],
      [SEND_PATH, "wallet-json-b"],
    ] as const;
    const messageIds: string[] = [];

    for (const [pathname, clientMessageId] of requests) {
      const result = await runRoute("POST", pathname, state, {
        text: "what is my wallet address?",
        clientMessageId,
      });
      if (pathname === STREAM_PATH) {
        const done = parseDataFrames(result.record).find(
          (frame) => frame.type === "done",
        );
        expect(done?.fullText).toContain("Detected wallets");
        expect(done?.messageId).toBeTruthy();
        messageIds.push(String(done?.messageId));
      } else {
        const payload = result.captured.payload as {
          text?: string;
          messageId?: string;
        };
        expect(payload.text).toContain("Detected wallets");
        expect(payload.messageId).toBeTruthy();
        messageIds.push(String(payload.messageId));
      }
    }

    expect(handleMessage).not.toHaveBeenCalled();
    expect(new Set(messageIds)).toHaveProperty("size", 4);
    for (const messageId of messageIds) {
      expect(
        storedMemories.some(
          (memory) => memory.id === messageId && memory.entityId === AGENT_ID,
        ),
      ).toBe(true);
    }
  });

  it("SSE: sends without a clientMessageId are never deduped", async () => {
    const { state, handleMessage } = createHarness();
    const body = { text: "hello" };

    const first = await runRoute("POST", STREAM_PATH, state, body);
    const second = await runRoute("POST", STREAM_PATH, state, body);

    expect(handleMessage).toHaveBeenCalledTimes(2);
    for (const { record } of [first, second]) {
      const doneFrame = parseDataFrames(record).find((f) => f.type === "done");
      expect(doneFrame?.fullText).toBe("ok");
    }
  });

  it("non-stream: first send runs the turn; a retry after delivery returns the persisted first reply", async () => {
    const { state, handleMessage, createMemory } = createHarness();
    const body = { text: "hello", clientMessageId: "json-retry-1" };

    const first = await runRoute("POST", SEND_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const persistsAfterFirst = createMemory.mock.calls.length;
    expect(persistsAfterFirst).toBeGreaterThan(0);
    expect(first.captured.payload).toMatchObject({ text: "ok" });

    const second = await runRoute("POST", SEND_PATH, state, body);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledTimes(persistsAfterFirst);
    // The first attempt's reply already persisted — the retry answers with
    // the normal success shape carrying that reply, not the empty ignored
    // shape, so the already-delivered turn reads identically on both attempts.
    expect(second.captured.payload).toMatchObject({
      text: "ok",
      agentName: "Test Agent",
      messageId: expect.any(String),
    });
  });

  it("non-stream: a dupe landing while the original is still mid-turn keeps the ignored shape", async () => {
    const { state, handleMessage } = createHarness();
    expect(markChatMessageSeen(ROOM_ID, "json-mid-turn-1")).toBe(false);

    const retry = await runRoute("POST", SEND_PATH, state, {
      text: "hello",
      clientMessageId: "json-mid-turn-1",
    });

    expect(handleMessage).not.toHaveBeenCalled();
    expect(retry.captured.payload).toEqual({
      text: "",
      agentName: "Test Agent",
      noResponseReason: "ignored",
    });
  });

  it("non-stream: sends without a clientMessageId are never deduped", async () => {
    const { state, handleMessage } = createHarness();
    const body = { text: "hello" };

    const first = await runRoute("POST", SEND_PATH, state, body);
    const second = await runRoute("POST", SEND_PATH, state, body);

    expect(handleMessage).toHaveBeenCalledTimes(2);
    expect(first.captured.payload).toMatchObject({ text: "ok" });
    expect(second.captured.payload).toMatchObject({ text: "ok" });
  });

  it("distinct clientMessageIds in the same conversation both run", async () => {
    const { state, handleMessage } = createHarness();

    await runRoute("POST", SEND_PATH, state, {
      text: "hello",
      clientMessageId: "distinct-a",
    });
    await runRoute("POST", SEND_PATH, state, {
      text: "hello",
      clientMessageId: "distinct-b",
    });

    expect(handleMessage).toHaveBeenCalledTimes(2);
  });

  it("a retry that lands on the non-stream twin of a streamed send is still suppressed", async () => {
    // Both handlers consult the SAME cache scoped by conversation room id, so
    // a duplicate is caught regardless of which endpoint the retry hits — and
    // the delivered first reply is returned across the endpoint boundary too.
    const { state, handleMessage } = createHarness();
    const body = { text: "hello", clientMessageId: "cross-route-1" };

    await runRoute("POST", STREAM_PATH, state, body);
    const retry = await runRoute("POST", SEND_PATH, state, body);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(retry.captured.payload).toMatchObject({
      text: "ok",
      agentName: "Test Agent",
      messageId: expect.any(String),
    });
  });
});
