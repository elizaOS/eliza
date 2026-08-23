/**
 * Resource-release contract for the conversation stream route on the throw
 * path (#24030).
 *
 * `POST /api/conversations/:id/messages/stream` arms a 5s SSE heartbeat
 * `setInterval` before durable-idempotency recovery, the room lease and the
 * model turn. Every ordinary exit clears it by hand; a throw in the turn-setup
 * window used to walk past both `clearInterval` and `finishStreamResponse`,
 * leaking a timer per failed request, leaving the response un-ended (so the
 * client waits forever with no error frame) and retaining the
 * `req`/`res`/socket listeners the disconnect tracker registered.
 *
 * These cases drive the real `handleConversationRoutes` handler and force the
 * throw at the durable-recovery store read — the first store call inside the
 * previously-uncovered window — then assert the whole release set: the
 * structured SSE `error` frame, the response end, the cleared interval, the
 * disposed disconnect listeners, the released room lease, the released
 * idempotency reservation, and re-propagation to the J1 boundary. A successful
 * turn and an early-return exit are retained as controls so the broadened
 * outer `finally` cannot regress the exits that already cleaned up.
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import {
  type AgentRuntime,
  ChannelType,
  logger,
  type Memory,
  RoomHandlerQueue,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let requestClientMessageId: string | undefined;
const REQUEST_PROMPT = "release the heartbeat on the throw path";

vi.mock("../chat-routes.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-routes.ts")>(
      "../chat-routes.ts",
    );
  return {
    ...actual,
    readChatRequestPayload: vi.fn(async () => ({
      prompt: REQUEST_PROMPT,
      channelType: ChannelType.DM,
      images: undefined,
      preferredLanguage: undefined,
      source: "api",
      metadata: undefined,
      ...(requestClientMessageId
        ? { clientMessageId: requestClientMessageId }
        : {}),
    })),
    persistConversationMemory: vi.fn(async (runtime, memory) => {
      await runtime.createMemory(memory, "messages");
      return memory;
    }),
    persistAssistantConversationMemory: vi.fn(
      async (runtime, roomId, content, _channelType, _dedupeSinceMs, id) => {
        const memory = {
          id: id ?? stringToUuid("heartbeat-release-assistant"),
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId,
          content:
            typeof content === "string" ? { text: content } : { ...content },
          createdAt: Date.now(),
        } as Memory;
        await runtime.createMemory(memory, "messages");
        return memory as never;
      },
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
    buildUserMessages: vi.fn(async ({ prompt, userId, agentId, roomId }) => {
      const content = {
        text: prompt,
        source: "api",
        channelType: ChannelType.DM,
      };
      return {
        userMessage: {
          id: stringToUuid("heartbeat-release-user-msg"),
          entityId: userId,
          agentId,
          roomId,
          content,
          metadata: {},
        },
        messageToStore: {
          id: stringToUuid("heartbeat-release-user-msg-store"),
          entityId: userId,
          agentId,
          roomId,
          content,
          metadata: {},
        },
      };
    }),
    resolveWalletModeGuidanceReply: () => null,
    resolveAppUserName: () => "tester",
  };
});

import type {
  ConversationRouteContext,
  ConversationRouteState,
} from "../conversation-routes.ts";
import { handleConversationRoutes } from "../conversation-routes.ts";

const AGENT_ID = stringToUuid("heartbeat-release-agent") as UUID;
const USER_ID = stringToUuid("heartbeat-release-user") as UUID;
const ROOM_ID = stringToUuid("heartbeat-release-room") as UUID;
const FINAL_TEXT = "released.";
const STORE_FAILURE = "db: connection terminated unexpectedly";

const TRACKED_REQ_EVENTS = ["aborted", "close", "error"] as const;
const TRACKED_SOCKET_EVENTS = ["close", "error"] as const;

interface MockResponseRecord {
  headers: Record<string, string>;
  writes: string[];
  ended: boolean;
}

type MockSocket = EventEmitter & { destroyed: boolean; writable: boolean };

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
  Object.defineProperty(req, "socket", { configurable: true, value: socket });
  return req as http.IncomingMessage;
}

function createMockRes(): {
  res: http.ServerResponse;
  record: MockResponseRecord;
} {
  const record: MockResponseRecord = { headers: {}, writes: [], ended: false };
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

function countHeartbeats(writes: string[]): number {
  return writes.filter((chunk) => chunk.includes(": heartbeat")).length;
}

function trackedListenerCount(
  req: http.IncomingMessage,
  socket: MockSocket,
): number {
  return (
    TRACKED_REQ_EVENTS.reduce(
      (total, event) => total + req.listenerCount(event),
      0,
    ) +
    TRACKED_SOCKET_EVENTS.reduce(
      (total, event) => total + socket.listenerCount(event),
      0,
    )
  );
}

function createRespondingMessageService(): NonNullable<
  AgentRuntime["messageService"]
> {
  return {
    async handleMessage() {
      return {
        didRespond: true,
        responseContent: { text: FINAL_TEXT, thought: "done" },
        responseMessages: [],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "heartbeat-release-test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } as unknown as NonNullable<AgentRuntime["messageService"]>;
}

function createState(): {
  state: ConversationRouteState;
  getMemoriesByIds: ReturnType<typeof vi.fn>;
  runtime: AgentRuntime;
} {
  const conv = {
    id: "conv-1",
    title: "heartbeat release conv",
    roomId: ROOM_ID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const worlds = new Map<UUID, Record<string, unknown>>();
  const storedMemories = new Map<UUID, Memory>();
  const getMemoriesByIds = vi.fn(async (ids: UUID[]) =>
    ids.flatMap((id) => {
      const stored = storedMemories.get(id);
      return stored ? [stored] : [];
    }),
  );
  const runtime = {
    agentId: AGENT_ID,
    character: { name: "Release Agent", system: "System prompt", settings: {} },
    actions: [],
    plugins: [],
    logger,
    emitEvent: vi.fn(async () => undefined),
    useModel: vi.fn(),
    messageService: createRespondingMessageService(),
    ensureConnection: vi.fn(async (input: { worldId?: UUID }) => {
      if (!input.worldId) throw new Error("worldId is required");
      if (!worlds.has(input.worldId)) {
        worlds.set(input.worldId, { id: input.worldId, agentId: AGENT_ID });
      }
    }),
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
    updateMemory: vi.fn(async () => true),
    getMemories: vi.fn(async ({ roomId }: { roomId: UUID }) =>
      [...storedMemories.values()].filter((memory) => memory.roomId === roomId),
    ),
    getMemoriesByIds,
    reportError: vi.fn(),
    abortTurn: vi.fn(),
    roomHandlerQueue: new RoomHandlerQueue(),
    adapter: {},
  } as unknown as AgentRuntime;

  return {
    getMemoriesByIds,
    runtime,
    state: {
      runtime,
      config: { user: { name: "tester" } } as never,
      agentName: "Release Agent",
      adminEntityId: USER_ID,
      chatUserId: USER_ID,
      logBuffer: [],
      conversations: new Map([[conv.id, conv]]),
      activeChatTurnCount: 0,
      conversationRestorePromise: null,
      deletedConversationIds: new Set(),
      broadcastWs: null,
    } as unknown as ConversationRouteState,
  };
}

function createCtx(state: ConversationRouteState): {
  ctx: ConversationRouteContext;
  record: MockResponseRecord;
  req: http.IncomingMessage;
  socket: MockSocket;
} {
  const socket = createMockSocket();
  const req = createReq(socket);
  const { res, record } = createMockRes();
  const ctx = {
    req,
    res,
    method: "POST",
    pathname: "/api/conversations/conv-1/messages/stream",
    state,
    readJsonBody: vi.fn(async () => ({ prompt: "unused" })),
    json: vi.fn(),
    error: vi.fn((response: http.ServerResponse, message, status) => {
      response.write(`error ${status}: ${message}`);
      response.end();
    }),
  } as unknown as ConversationRouteContext;
  return { ctx, record, req, socket };
}

describe("conversation stream heartbeat release on the throw path (#24030)", () => {
  beforeEach(() => {
    // Only the heartbeat clock is faked, so `getTimerCount()` reads the
    // route's own interval and the awaited async work still runs for real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    requestClientMessageId = undefined;
  });

  it("releases the heartbeat, the response and the listeners when durable recovery throws", async () => {
    requestClientMessageId = "heartbeat-release-throw";
    const { state, getMemoriesByIds, runtime } = createState();
    const { ctx, record, req, socket } = createCtx(state);
    getMemoriesByIds.mockRejectedValueOnce(new Error(STORE_FAILURE));

    await expect(handleConversationRoutes(ctx)).rejects.toThrow(STORE_FAILURE);

    // The failure reached the store call the previously-uncovered window
    // reaches first, i.e. the throw is the one this route regressed on.
    expect(getMemoriesByIds).toHaveBeenCalledTimes(1);

    // 1. structured SSE error frame — the route's documented failure contract.
    const frames = parseSsePayloads(record.writes);
    expect(frames).toContainEqual({ type: "error", message: STORE_FAILURE });

    // 2. the response is ended rather than left open behind a live heartbeat.
    expect(record.ended).toBe(true);

    // 3. the heartbeat interval is cleared and writes no further frames.
    expect(vi.getTimerCount()).toBe(0);
    const heartbeatsAtFailure = countHeartbeats(record.writes);
    vi.advanceTimersByTime(30_000);
    expect(countHeartbeats(record.writes)).toBe(heartbeatsAtFailure);

    // 4. the disconnect tracker's req/res/socket listeners are disposed.
    expect(trackedListenerCount(req, socket)).toBe(0);

    // 5. the room lease is released, so the room is not wedged.
    expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);
  });

  it("releases the idempotency reservation so the same clientMessageId can retry", async () => {
    requestClientMessageId = "heartbeat-release-retry";
    const { state, getMemoriesByIds } = createState();
    const failing = createCtx(state);
    getMemoriesByIds.mockRejectedValueOnce(new Error(STORE_FAILURE));

    await expect(handleConversationRoutes(failing.ctx)).rejects.toThrow(
      STORE_FAILURE,
    );

    // A retained reservation would block or conflict this identical retry;
    // it completes, so the failed turn gave the key back.
    const retry = createCtx(state);
    await handleConversationRoutes(retry.ctx);

    const frames = parseSsePayloads(retry.record.writes);
    expect(frames.filter((frame) => frame.type === "done")).toHaveLength(1);
    expect(retry.record.ended).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("control: a successful turn still ends clean", async () => {
    const { state, runtime } = createState();
    const { ctx, record, req, socket } = createCtx(state);

    await handleConversationRoutes(ctx);

    const frames = parseSsePayloads(record.writes);
    expect(frames.filter((frame) => frame.type === "done")).toHaveLength(1);
    expect(frames.some((frame) => frame.type === "error")).toBe(false);
    expect(record.ended).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(trackedListenerCount(req, socket)).toBe(0);
    expect(runtime.roomHandlerQueue.pendingFor(ROOM_ID)).toBe(0);
  });

  it("control: the early return for an unavailable runtime still ends clean", async () => {
    const { state } = createState();
    (state as { runtime: AgentRuntime | null }).runtime = null;
    const { ctx, record, req, socket } = createCtx(state);

    await handleConversationRoutes(ctx);

    const frames = parseSsePayloads(record.writes);
    expect(frames).toContainEqual({
      type: "error",
      message: "Agent is not running",
    });
    expect(record.ended).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(trackedListenerCount(req, socket)).toBe(0);
  });
});
