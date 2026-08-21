/**
 * Verifies that the streaming chat handler treats `done` as a durable commit
 * boundary: assistant persistence resolves before the terminal frame and both
 * ids in that frame already exist. Persistence failures become terminal SSE
 * errors rather than a false successful completion.
 */

import { EventEmitter } from "node:events";
import http from "node:http";
import {
  ChannelType,
  logger,
  type Memory,
  RoomHandlerQueue,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the persistence promise so the test can resolve it on demand and
// assert that the terminal frame stays behind the durable write.
let persistResolve: (() => void) | null = null;
let persistCalledAt: number | null = null;
let persistResolvedAt: number | null = null;
let captureGenerateAbortSignal: AbortSignal | undefined;
let generateWaitsForAbort = false;
let generateThrowsTurnAbort = false;
let generateThrowsTimeout = false;
let generateReturnsExactPersisted = false;
let generateReturnsExactInternal = false;
let normalizeThrowsAfterResult = false;
let exactPersistedCallbackHistory: string[] | undefined;
let requestClientMessageId: string | undefined;
const EXACT_PERSISTED_ID = stringToUuid("exact-persisted-assistant") as UUID;
const EXACT_INTERNAL_ID = stringToUuid("exact-internal-assistant") as UUID;

// Connection readiness has its own integration suite. This fixture isolates
// the later assistant commit boundary and therefore supplies an already-valid
// descriptor without running world/room topology writes.
vi.mock("../conversation-connection-readiness.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../conversation-connection-readiness.ts")
  >("../conversation-connection-readiness.ts");
  return {
    ...actual,
    captureConversationConnectionDescriptor: vi.fn((input) => ({
      ...input,
      runtimeAgentId: input.runtime.agentId,
      topologyIdentity: "test-topology",
      proofIdentity: "test-proof",
      topologyGeneration: 1,
      roomGeneration: 1,
    })),
    scheduleConversationConnectionEnsure: vi.fn(async () => undefined),
    assertConversationConnectionRuntime: vi.fn(),
  };
});

vi.mock("../chat-routes.ts", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-routes.ts")>(
      "../chat-routes.ts",
    );
  return {
    ...actual,
    initSse: vi.fn((res: http.ServerResponse) => {
      res.setHeader("Content-Type", "text/event-stream");
    }),
    writeSse: vi.fn((res: http.ServerResponse, payload: object) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }),
    writeSseJson: vi.fn((res: http.ServerResponse, payload: object) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }),
    writeChatTokenSse: vi.fn(
      (res: http.ServerResponse, chunk: string, fullText: string) => {
        res.write(
          `data: ${JSON.stringify({ type: "token", text: chunk, fullText })}\n\n`,
        );
      },
    ),
    readChatRequestPayload: vi.fn(async () => ({
      prompt: "hello",
      channelType: ChannelType.DM,
      images: undefined,
      preferredLanguage: undefined,
      source: "api",
      metadata: undefined,
      clientMessageId: requestClientMessageId,
    })),
    persistConversationMemory: vi.fn(async () => undefined),
    persistAssistantConversationMemory: vi.fn(
      async (
        runtime,
        roomId,
        content,
        _channelType,
        _dedupeSinceMs,
        memoryId,
      ) => {
        persistCalledAt = Date.now();
        return new Promise<Memory>((resolve) => {
          persistResolve = () => {
            persistResolvedAt = Date.now();
            resolve({
              id: memoryId ?? stringToUuid("persisted-assistant"),
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              roomId,
              content:
                typeof content === "string" ? { text: content } : content,
            });
          };
        });
      },
    ),
    generateChatResponse: vi.fn(async (runtime, msg, agentName, opts) => {
      captureGenerateAbortSignal = opts?.abortSignal;
      if (generateThrowsTurnAbort) {
        const err = new Error("Turn aborted: ui-chat-abort") as Error & {
          code?: string;
        };
        err.name = "TurnAbortedError";
        err.code = "TURN_ABORTED";
        throw err;
      }
      if (generateThrowsTimeout) {
        throw new Error("Chat generation timed out after 180000ms");
      }
      if (generateWaitsForAbort) {
        await new Promise<void>((resolve) => {
          opts?.abortSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error("aborted");
      }
      if (generateReturnsExactPersisted) {
        return {
          text: "Already durable.",
          agentName,
          responseContent: { text: "Already durable." },
          actionCallbackHistory: exactPersistedCallbackHistory,
          responseMessages: [
            {
              id: EXACT_PERSISTED_ID,
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              roomId: msg.roomId,
              content: { text: "Already durable." },
            },
          ],
          persistedResponseMessageIds: [EXACT_PERSISTED_ID],
        };
      }
      if (generateReturnsExactInternal) {
        return {
          text: "Internal diagnostic.",
          agentName,
          transcriptVisibility: "internal" as const,
          responseContent: {
            text: "Internal diagnostic.",
            transcriptVisibility: "internal" as const,
          },
          responseMessages: [
            {
              id: EXACT_INTERNAL_ID,
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              roomId: msg.roomId,
              content: {
                text: "Internal diagnostic.",
                transcriptVisibility: "internal" as const,
              },
            },
          ],
          persistedResponseMessageIds: [EXACT_INTERNAL_ID],
        };
      }
      // Stream a single token so the SSE wire format mirrors a real turn.
      opts?.onChunk?.("ok");
      return {
        text: "ok",
        agentName,
        usage: undefined,
        usedActionCallbacks: false,
        actionCallbackHistory: undefined,
        noResponseReason: undefined,
      };
    }),
    normalizeChatResponseText: (text: string) => {
      if (normalizeThrowsAfterResult) {
        normalizeThrowsAfterResult = false;
        throw new Error("post-result normalization failed");
      }
      return text;
    },
    resolveNoResponseFallback: () => "",
  };
});

// `buildUserMessages` and other helpers in server-helpers.ts dive into runtime
// internals; replace the surface the handler actually needs.
vi.mock("../server-helpers.ts", async () => {
  const actual = await vi.importActual<typeof import("../server-helpers.ts")>(
    "../server-helpers.ts",
  );
  return {
    ...actual,
    buildUserMessages: vi.fn(({ prompt, userId, agentId, roomId }) => ({
      userMessage: {
        id: stringToUuid("user-msg"),
        entityId: userId,
        agentId,
        roomId,
        content: { text: prompt, source: "api", channelType: ChannelType.DM },
        metadata: {},
      },
      messageToStore: {
        id: stringToUuid("user-msg-store"),
        entityId: userId,
        agentId,
        roomId,
        content: { text: prompt, source: "api", channelType: ChannelType.DM },
        metadata: {},
      },
    })),
    resolveWalletModeGuidanceReply: () => null,
    resolveAppUserName: () => "tester",
  };
});

// Skip world ownership writes — they touch the adapter this fixture does not provide.
vi.mock("../character-routes.ts", async () => {
  const actual = await vi
    .importActual<Record<string, unknown>>("../character-routes.ts")
    .catch(() => ({}));
  return actual;
});

import {
  generateChatResponse,
  persistAssistantConversationMemory,
  readChatRequestPayload,
} from "../chat-routes.ts";
import type {
  ConversationRouteContext,
  ConversationRouteState,
} from "../conversation-routes.ts";
import { handleConversationRoutes } from "../conversation-routes.ts";

interface MockResponseRecord {
  writes: string[];
  ended: boolean;
  endedAt: number | null;
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

function createMockReq(socket: MockSocket): http.IncomingMessage {
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
    writes: [],
    ended: false,
    endedAt: null,
  };
  // We don't need a real ServerResponse; only the methods the handler calls.
  const responseFixture = {
    setHeader: vi.fn(),
    write: vi.fn((chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      record.writes.push(text);
      return true;
    }),
    end: vi.fn(() => {
      record.ended = true;
      record.endedAt = Date.now();
    }),
    writableEnded: false,
  } as unknown as http.ServerResponse;
  return { res: responseFixture, record };
}

function createState(): ConversationRouteState {
  const roomId = stringToUuid("room-1") as UUID;
  const adminId = stringToUuid("admin-1") as UUID;
  const worlds = new Map<
    UUID,
    { id: UUID; agentId: UUID; metadata: Record<string, unknown> }
  >();
  const storedMemories = new Map<UUID, Memory>();
  const conv = {
    id: "conv-1",
    title: "Test conv",
    roomId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const runtime = {
    agentId: stringToUuid("agent-1"),
    character: { name: "Test Agent" },
    logger,
    ensureConnection: vi.fn(async (input: { worldId?: UUID }) => {
      if (!input.worldId) throw new Error("worldId is required");
      if (!worlds.has(input.worldId)) {
        worlds.set(input.worldId, {
          id: input.worldId,
          agentId: stringToUuid("agent-1"),
          metadata: {},
        });
      }
    }),
    updateWorld: vi.fn(async () => undefined),
    getWorld: vi.fn(async (worldId: UUID) => worlds.get(worldId) ?? null),
    getRoom: vi.fn(async () => null),
    getParticipantsForRoom: vi.fn(async () => [
      adminId,
      stringToUuid("agent-1"),
    ]),
    createMemory: vi.fn(async (memory: Memory) => {
      if (memory.id) storedMemories.set(memory.id as UUID, memory);
      return memory.id;
    }),
    getMemoriesByIds: vi.fn(async (ids: UUID[]) => {
      const stored = ids
        .map((id) => storedMemories.get(id))
        .filter((memory): memory is Memory => Boolean(memory));
      if (stored.length > 0) return stored;
      if (ids.includes(EXACT_PERSISTED_ID)) {
        return [
          {
            id: EXACT_PERSISTED_ID,
            entityId: stringToUuid("agent-1"),
            agentId: stringToUuid("agent-1"),
            roomId,
            content: { text: "<response>Already durable.</response>" },
            createdAt: Date.now(),
          },
        ];
      }
      if (ids.includes(EXACT_INTERNAL_ID)) {
        return [
          {
            id: EXACT_INTERNAL_ID,
            entityId: stringToUuid("agent-1"),
            agentId: stringToUuid("agent-1"),
            roomId,
            content: {
              text: "Internal diagnostic.",
              transcriptVisibility: "internal" as const,
            },
            createdAt: Date.now(),
          },
        ];
      }
      return [];
    }),
    updateMemory: vi.fn(async () => undefined),
    roomHandlerQueue: new RoomHandlerQueue(),
    adapter: {},
  };
  return {
    runtime: runtime as never,
    config: { user: { name: "tester" } } as never,
    agentName: "Test Agent",
    adminEntityId: adminId,
    chatUserId: adminId,
    logBuffer: [],
    conversations: new Map([[conv.id, conv]]),
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
  };
}

function createCtx(): {
  ctx: ConversationRouteContext;
  record: MockResponseRecord;
  state: ConversationRouteState;
  socket: MockSocket;
} {
  const socket = createMockSocket();
  const req = createMockReq(socket);
  const { res, record } = createMockRes();
  const state = createState();
  const ctx: ConversationRouteContext = {
    req,
    res,
    method: "POST",
    pathname: "/api/conversations/conv-1/messages/stream",
    state,
    readJsonBody: vi.fn(async () => ({ prompt: "hello" })),
    json: vi.fn(),
    error: vi.fn((response, message, status) => {
      response.write(`error ${status}: ${message}`);
      response.end();
    }),
  } as unknown as ConversationRouteContext;
  return { ctx, record, state, socket };
}

describe("conversation-routes streaming persistence ordering", () => {
  beforeEach(() => {
    persistResolve = null;
    persistCalledAt = null;
    persistResolvedAt = null;
    captureGenerateAbortSignal = undefined;
    generateWaitsForAbort = false;
    generateThrowsTurnAbort = false;
    generateThrowsTimeout = false;
    generateReturnsExactPersisted = false;
    generateReturnsExactInternal = false;
    normalizeThrowsAfterResult = false;
    exactPersistedCallbackHistory = undefined;
    requestClientMessageId = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits `done` only after both advertised memories are durable", async () => {
    const { ctx, record } = createCtx();

    // Kick the handler off; do NOT await — persistence is hanging.
    const handlerDone = handleConversationRoutes(ctx);

    // Yield repeatedly so the handler reaches the pending persistence write.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(persistCalledAt).not.toBeNull();
    expect(persistResolvedAt).toBeNull();
    expect(record.writes.some((w) => w.includes('"type":"done"'))).toBe(false);
    expect(record.ended).toBe(false);

    // Once persistence resolves, the terminal frame may safely carry its id.
    persistResolve?.();
    await handlerDone;
    expect(persistResolvedAt).not.toBeNull();
    const doneFrame = record.writes.find((w) => w.includes('"type":"done"'));
    const routeOwnedAssistantId = vi.mocked(persistAssistantConversationMemory)
      .mock.calls[0]?.[5];
    expect(routeOwnedAssistantId).toBeDefined();
    expect(doneFrame).toContain(`"messageId":"${routeOwnedAssistantId}"`);
    expect(doneFrame).toContain(
      `"userMessageId":"${stringToUuid("user-msg-store")}"`,
    );
    expect(record.ended).toBe(true);
    expect(record.endedAt).not.toBeNull();
    expect(record.endedAt ?? 0).toBeGreaterThanOrEqual(persistResolvedAt ?? 0);
  });

  it("returns an SSE error instead of an orphan done id when persistence fails", async () => {
    const { ctx, record } = createCtx();
    vi.mocked(persistAssistantConversationMemory).mockRejectedValue(
      new Error("simulated db failure"),
    );

    await handleConversationRoutes(ctx);
    expect(record.ended).toBe(true);
    expect(record.writes.some((w) => w.includes('"type":"done"'))).toBe(false);
    expect(record.writes.some((w) => w.includes('"type":"error"'))).toBe(true);
    expect(record.writes.join("")).toContain("simulated db failure");
  });

  it("aborts generation when the client socket closes after request body parsing", async () => {
    generateWaitsForAbort = true;
    const { ctx, record, socket } = createCtx();

    vi.mocked(readChatRequestPayload).mockImplementationOnce(async () => {
      // Bun emits req.close when the POST body finishes. This must not abort
      // the SSE turn, but the already-installed socket listener must still see
      // a later client disconnect.
      ctx.req.emit("close");
      return {
        prompt: "hello",
        channelType: ChannelType.DM,
        images: undefined,
        preferredLanguage: undefined,
        source: "api",
        metadata: undefined,
      };
    });

    const handlerDone = handleConversationRoutes(ctx);
    for (let i = 0; i < 10 && !captureGenerateAbortSignal; i++) {
      await new Promise((r) => setImmediate(r));
    }

    expect(captureGenerateAbortSignal).toBeDefined();
    expect(captureGenerateAbortSignal?.aborted).toBe(false);

    socket.destroyed = true;
    socket.writable = false;
    socket.emit("close");

    await handlerDone;
    expect(captureGenerateAbortSignal?.aborted).toBe(true);
    expect(record.ended).toBe(true);
  });

  it("settles an aborted turn with an interrupted receipt instead of fallback generation", async () => {
    generateThrowsTurnAbort = true;
    const { ctx, record } = createCtx();

    await handleConversationRoutes(ctx);

    expect(record.ended).toBe(true);
    // No fallback reply is generated or persisted through the normal
    // assistant-persistence seam; the terminal state is the interrupted
    // receipt (#17216), delivered as a done frame because the transport is
    // still connected.
    const doneFrame = record.writes.find((w) => w.includes('"type":"done"'));
    expect(doneFrame).toBeDefined();
    expect(doneFrame).toContain('"interrupted":true');
    expect(doneFrame).toContain('"fullText":""');
    expect(record.writes.some((w) => w.includes('"type":"error"'))).toBe(false);
    expect(persistCalledAt).toBeNull();
  });

  it("replays only the exact correlated visible row when a post-result step fails", async () => {
    generateReturnsExactPersisted = true;
    normalizeThrowsAfterResult = true;
    const { ctx, record } = createCtx();

    await handleConversationRoutes(ctx);

    expect(persistAssistantConversationMemory).not.toHaveBeenCalled();
    expect(record.writes.join("")).toContain('"type":"done"');
    expect(record.writes.join("")).toContain('"fullText":"Already durable."');
    expect(record.writes.join("")).toContain(
      `"messageId":"${EXACT_PERSISTED_ID}"`,
    );
    expect(record.writes.join("")).not.toContain("provider issue");
    expect(record.ended).toBe(true);
  });

  it("reports exact-salvage callback failure and releases the retry key", async () => {
    generateReturnsExactPersisted = true;
    exactPersistedCallbackHistory = ["VIEWS"];
    requestClientMessageId = "post-result-callback-retry";
    normalizeThrowsAfterResult = true;
    const first = createCtx();
    if (!first.state.runtime) throw new Error("runtime fixture missing");
    first.state.runtime.updateMemory = vi.fn(async () => {
      throw new Error("callback metadata write failed");
    });

    const callsBefore = vi.mocked(generateChatResponse).mock.calls.length;
    await handleConversationRoutes(first.ctx);

    const firstPayloads = first.record.writes
      .filter((write) => write.startsWith("data: "))
      .map(
        (write) =>
          JSON.parse(write.slice(6)) as { message?: string; type?: string },
      );
    expect(
      firstPayloads.filter((payload) => payload.type === "error"),
    ).toHaveLength(1);
    expect(
      firstPayloads.find((payload) => payload.type === "error")?.message,
    ).toContain("Failed to persist action callback history");
    expect(firstPayloads.some((payload) => payload.type === "done")).toBe(
      false,
    );
    expect(first.record.ended).toBe(true);
    expect(vi.mocked(generateChatResponse)).toHaveBeenCalledTimes(
      callsBefore + 1,
    );

    normalizeThrowsAfterResult = true;
    const retry = createCtx();
    await handleConversationRoutes(retry.ctx);

    expect(vi.mocked(generateChatResponse)).toHaveBeenCalledTimes(
      callsBefore + 2,
    );
    expect(retry.record.writes.join("")).toContain('"type":"done"');
    expect(retry.record.writes.join("")).not.toContain(
      '"noResponseReason":"ignored"',
    );
    expect(retry.record.ended).toBe(true);
  });

  it("does not treat an exact internal-only row as a visible terminal reply", async () => {
    generateReturnsExactInternal = true;
    normalizeThrowsAfterResult = true;
    vi.mocked(persistAssistantConversationMemory).mockImplementationOnce(
      async (
        runtime,
        roomId,
        content,
        _channelType,
        _dedupeSinceMs,
        memoryId,
      ) =>
        ({
          id: memoryId ?? stringToUuid("visible-fallback"),
          entityId: runtime.agentId,
          agentId: runtime.agentId,
          roomId,
          content: typeof content === "string" ? { text: content } : content,
        }) as never,
    );
    const { ctx, record } = createCtx();

    await handleConversationRoutes(ctx);

    expect(record.writes.join("")).not.toContain("Internal diagnostic.");
    expect(record.writes.join("")).toContain('"type":"done"');
    expect(record.writes.join("")).toContain("provider issue");
    expect(record.writes.join("")).toContain('"messageId"');
    expect(record.ended).toBe(true);
  });
});
