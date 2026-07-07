/**
 * Route-level wiring coverage for the HTTP chat idempotency guard on the
 * dedicated-agent conversation endpoints (`POST /api/conversations/:id/messages`
 * and its `/stream` twin). The pure decision function is pinned in
 * `chat-idempotency.test.ts`; these tests prove the routes actually consult it:
 * a first send runs the LLM turn, a retry carrying the SAME `clientMessageId`
 * within the TTL is suppressed (no second turn, no second persisted memory, a
 * clean terminal response for the client), and a send WITHOUT an idempotency
 * key behaves exactly as before (no dedupe).
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
import type { AgentRuntime } from "@elizaos/core";
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

beforeAll(async () => {
  vi.resetModules();
  const chatRoutes = await import("../chat-routes.ts");
  resetChatDedupe = chatRoutes.__resetChatDedupeForTests;
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
}

/** Real-route harness: the runtime stub streams one "ok" chunk per turn via
 *  the message service, so the real `generateChatResponse` pipeline (status →
 *  token → done framing, persistence ordering) runs unmodified. */
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
  const createMemory = vi.fn(async () => stringToUuid("created-memory"));
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
    getMemories: vi.fn(async () => []),
    ensureConnection: vi.fn(async () => undefined),
    updateWorld: vi.fn(async () => undefined),
    getWorld: vi.fn(async () => null),
    getRoom: vi.fn(async () => null),
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

  return { state, handleMessage, createMemory };
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

/** Drive one request through the real route handler, then drain the event loop
 *  so streamed chunks and the post-`done` deferred persistence both settle
 *  before the caller asserts on call counts. */
async function runRoute(
  method: string,
  pathname: string,
  state: ConversationRouteState,
  body: Record<string, unknown>,
): Promise<{ record: MockResponseRecord; captured: CapturedJson }> {
  const { res, record } = createMockRes();
  const captured: CapturedJson = { payload: undefined };
  const ctx = {
    req: createReq(method, pathname),
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

function parseDataFrames(
  record: MockResponseRecord,
): Array<{ type: string; fullText?: string }> {
  return record.writes
    .join("")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as {
          type: string;
          fullText?: string;
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

  it("SSE: first send runs the turn; a retry with the same clientMessageId is suppressed", async () => {
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
    // The client still gets a clean terminal frame (an empty completed turn →
    // it drops the optimistic placeholder and reconciles from history).
    const frames = parseDataFrames(second.record);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "done", fullText: "" });
    expect(second.record.ended).toBe(true);
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

  it("non-stream: first send runs the turn; a retry with the same clientMessageId gets an idempotent 200", async () => {
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
    // Same success shape as an ignored turn — the client maps it to an empty
    // reply instead of surfacing an error for the already-delivered turn.
    expect(second.captured.payload).toEqual({
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
    // a duplicate is caught regardless of which endpoint the retry hits.
    const { state, handleMessage } = createHarness();
    const body = { text: "hello", clientMessageId: "cross-route-1" };

    await runRoute("POST", STREAM_PATH, state, body);
    const retry = await runRoute("POST", SEND_PATH, state, body);

    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(retry.captured.payload).toMatchObject({
      noResponseReason: "ignored",
    });
  });
});
