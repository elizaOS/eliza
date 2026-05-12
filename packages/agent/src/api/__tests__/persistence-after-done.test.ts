/**
 * Verifies that the streaming chat handler emits the SSE `done` frame and
 * closes the response BEFORE assistant-memory persistence resolves, so the
 * user-perceived end-of-turn excludes the persistence write. Also verifies
 * that persistence rejections still surface via the structured logger
 * instead of being silently swallowed.
 */

import http from "node:http";
import { ChannelType, logger, stringToUuid, type UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the deferred persistence promise the handler kicks off so the test
// can resolve it on demand and assert ordering against the SSE writes.
let persistResolve: ((value?: unknown) => void) | null = null;
let persistReject: ((err: unknown) => void) | null = null;
let persistCalledAt: number | null = null;
let persistResolvedAt: number | null = null;

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
      conversationMode: undefined,
      preferredLanguage: undefined,
      source: "api",
      metadata: undefined,
    })),
    persistConversationMemory: vi.fn(async () => undefined),
    persistAssistantConversationMemory: vi.fn(async () => {
      persistCalledAt = Date.now();
      return new Promise((resolve, reject) => {
        persistResolve = (_value) => {
          persistResolvedAt = Date.now();
          resolve();
        };
        persistReject = (err) => {
          persistResolvedAt = Date.now();
          reject(err);
        };
      });
    }),
    generateChatResponse: vi.fn(async (_runtime, _msg, agentName, opts) => {
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
    normalizeChatResponseText: (text: string) => text,
    resolveNoResponseFallback: () => "",
  };
});

// `buildUserMessages` and other helpers in server-helpers.ts dive into runtime
// internals; stub the surface the handler actually needs.
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
      },
      messageToStore: {
        id: stringToUuid("user-msg-store"),
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

// Skip world ownership writes — they touch the adapter which we don't stub.
vi.mock("../character-routes.ts", async () => {
  const actual = await vi
    .importActual<Record<string, unknown>>("../character-routes.ts")
    .catch(() => ({}));
  return actual;
});

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

function createMockReq(): http.IncomingMessage {
  const req = Object.assign(new http.IncomingMessage(null as never), {
    method: "POST",
    url: "/api/conversations/conv-1/messages/stream",
    headers: {},
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
  const stub = {
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
  return { res: stub, record };
}

function createState(): ConversationRouteState {
  const roomId = stringToUuid("room-1") as UUID;
  const adminId = stringToUuid("admin-1") as UUID;
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
    ensureConnection: vi.fn(async () => undefined),
    updateWorld: vi.fn(async () => undefined),
    getWorld: vi.fn(async () => null),
    getRoom: vi.fn(async () => null),
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
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
  };
}

function createCtx(): {
  ctx: ConversationRouteContext;
  record: MockResponseRecord;
  state: ConversationRouteState;
} {
  const req = createMockReq();
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
  return { ctx, record, state };
}

describe("conversation-routes streaming persistence ordering", () => {
  beforeEach(() => {
    persistResolve = null;
    persistReject = null;
    persistCalledAt = null;
    persistResolvedAt = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("emits `done` frame and ends the response BEFORE persistence resolves", async () => {
    const { ctx, record } = createCtx();

    // Kick the handler off; do NOT await — persistence is hanging.
    const handlerDone = handleConversationRoutes(ctx);

    // Yield repeatedly so the handler reaches the `done` write + res.end().
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    const doneAt = (() => {
      const ts = record.writes.findIndex((w) => w.includes('"type":"done"'));
      return ts >= 0 ? ts : -1;
    })();
    expect(doneAt).toBeGreaterThanOrEqual(0);
    expect(record.ended).toBe(true);
    expect(persistCalledAt).not.toBeNull();
    expect(persistResolvedAt).toBeNull();

    // Now resolve persistence and let the handler clean up.
    persistResolve?.();
    await handlerDone;
    expect(persistResolvedAt).not.toBeNull();
    // res.end() ran before persistence finished.
    expect(record.endedAt).not.toBeNull();
    expect(record.endedAt ?? 0).toBeLessThanOrEqual(
      persistResolvedAt ?? Infinity,
    );
  });

  it("logs persistence failures via Logger.error and still ends the response cleanly", async () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const { ctx, record } = createCtx();

    const handlerDone = handleConversationRoutes(ctx);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(record.ended).toBe(true);
    const persistErr = new Error("simulated db failure");
    persistReject?.(persistErr);
    await handlerDone;
    // Detached catch handler runs after handlerDone resolves; flush microtasks.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    expect(errorSpy).toHaveBeenCalled();
    const call = errorSpy.mock.calls.find((c) => {
      const ctxArg = c[0] as { roomId?: unknown; err?: unknown } | undefined;
      const msg = c[1];
      return (
        typeof msg === "string" &&
        msg.includes("[ConversationStream] persistence failed") &&
        ctxArg !== undefined &&
        typeof ctxArg.err === "string" &&
        ctxArg.err.includes("simulated db failure")
      );
    });
    expect(call).toBeDefined();
    errorSpy.mockRestore();
  });
});
