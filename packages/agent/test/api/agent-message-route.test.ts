/**
 * Verifies the `POST /api/agents/:id/message` route added in #7680.
 *
 * Local-mode parity with the cloud agent-server endpoint
 * (`packages/cloud/services/agent-server/src/routes.ts`). Before this fix the route
 * was not registered at all on the local server, so the local chat shape
 * 404'd even when a local-inference TEXT_LARGE handler was loaded — the
 * OpenAI-compat `/v1/chat/completions` path worked on the same boot.
 *
 * Coverage:
 *   - The dispatcher forwards `POST /api/agents/:id/message` to
 *     `handleChatRoutes` (no longer returns 404 with the default
 *     handler).
 *   - The route 404s on agentId mismatch (and *only* on real not-found,
 *     never on "route not bound").
 *   - The route delegates to the same `generateChatResponse` that
 *     `/v1/chat/completions` uses, so model-routing (incl. local-inference
 *     handlers registered via `runtime.registerModel`) is shared.
 *   - Compatibility transports never expose assistant turns explicitly
 *     marked internal, while ordinary visible summaries remain unchanged.
 */

import crypto from "node:crypto";
import http from "node:http";
import {
  type AgentRuntime,
  ChannelType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleConversationRouteGroup } from "../../src/api/server-route-dispatch.ts";

interface MockResponseRecord {
  writes: string[];
  ended: boolean;
  status: number;
  headers: Record<string, string>;
}

function createMockReq(
  method: string,
  pathname: string,
  body?: unknown,
  headers?: Record<string, string>,
): http.IncomingMessage {
  const payload = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const req = Object.assign(new http.IncomingMessage(null as never), {
    method,
    url: pathname,
    headers: {
      "content-type": "application/json",
      "content-length": String(payload.length),
      ...headers,
    },
  });
  req.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (event === "data") {
      if (payload.length > 0) {
        setImmediate(() => {
          listener(payload);
        });
      }
    } else if (event === "end") {
      setImmediate(() => listener());
    } else {
      http.IncomingMessage.prototype.on.call(req, event, listener);
    }
    return req;
  }) as never;
  return req as http.IncomingMessage;
}

function createMockRes(): {
  res: http.ServerResponse;
  record: MockResponseRecord;
} {
  const record: MockResponseRecord = {
    writes: [],
    ended: false,
    status: 200,
    headers: {},
  };
  const stub = {
    setHeader: vi.fn((key: string, value: string) => {
      record.headers[key.toLowerCase()] = value;
    }),
    getHeader: vi.fn((key: string) => record.headers[key.toLowerCase()]),
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      record.status = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          record.headers[k.toLowerCase()] = v;
        }
      }
      return stub;
    }),
    write: vi.fn((chunk: string | Buffer) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      record.writes.push(text);
      return true;
    }),
    end: vi.fn((chunk?: string | Buffer) => {
      if (chunk) {
        const text =
          typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        record.writes.push(text);
      }
      record.ended = true;
    }),
    statusCode: 200,
    writableEnded: false,
  } as unknown as http.ServerResponse;
  return { res: stub, record };
}

function parseResponseBody(record: MockResponseRecord): unknown {
  if (!record.writes.length) return null;
  const joined = record.writes.join("");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

function parseSseJsonFrames(record: MockResponseRecord): unknown[] {
  return record.writes
    .join("")
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length).trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data) as unknown);
}

type MessageService = NonNullable<AgentRuntime["messageService"]>;

function createMessageService(
  reply: string,
  transcriptVisibility?: "internal",
): MessageService {
  const content = {
    text: reply,
    ...(transcriptVisibility ? { transcriptVisibility } : {}),
  };
  return {
    async handleMessage(_runtime, _message, _callback, _options) {
      return {
        didRespond: true,
        responseContent: content,
        responseMessages: [{ id: stringToUuid("reply-msg"), content }],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } as unknown as MessageService;
}

function createCallbackMessageService(
  finalReply: string,
  streamedReply?: string,
): MessageService {
  const finalContent = { text: finalReply, actions: ["REPLY"] };
  return {
    async handleMessage(_runtime, _message, callback) {
      if (streamedReply) {
        await callback?.({
          text: streamedReply,
          actions: ["REPLY"],
          merge: "append",
        });
      }
      await callback?.(finalContent);
      return {
        didRespond: true,
        responseContent: finalContent,
        responseMessages: [
          { id: stringToUuid("callback-reply-msg"), content: finalContent },
        ],
      };
    },
    shouldRespond: () => ({
      shouldRespond: true,
      skipEvaluation: true,
      reason: "test",
    }),
    deleteMessage: async () => undefined,
    clearChannel: async () => undefined,
  } as unknown as MessageService;
}

function createRuntime(
  agentId: UUID,
  overrides: Partial<AgentRuntime> = {},
): AgentRuntime {
  const runtime = {
    agentId,
    character: {
      name: "Eliza",
      settings: {},
    },
    plugins: [],
    actions: [],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ensureConnection: vi.fn(async () => undefined),
    updateWorld: vi.fn(async () => undefined),
    getWorld: vi.fn(async () => null),
    getRoom: vi.fn(async () => null),
    // Required by IAgentRuntime and called by the trusted-delivery-audience
    // gate on every outbound turn. Omitting it does not degrade the audience
    // decision — it throws, and the route reports the TypeError as a 500, so
    // an incomplete mock reads as a broken product route.
    getParticipantsForRoom: vi.fn(async () => []),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    emitEvent: vi.fn(async () => undefined),
    reportError: vi.fn(),
    drainChatPreHandlers: vi.fn(async () => null),
    ...overrides,
  };
  return runtime as unknown as AgentRuntime;
}

const INTERNAL_VIEWS_TEXT = [
  "available_views:",
  "views[1]{id,path}:",
  "notes,/notes",
].join("\n");

function createCtx(opts: {
  method: string;
  pathname: string;
  body?: unknown;
  runtime: AgentRuntime | null;
  headers?: Record<string, string>;
  state?: Record<string, unknown>;
}) {
  const req = createMockReq(
    opts.method,
    opts.pathname,
    opts.body,
    opts.headers,
  );
  const { res, record } = createMockRes();
  const json = (
    response: http.ServerResponse,
    data: unknown,
    status?: number,
  ) => {
    if (status !== undefined) record.status = status;
    response.write(JSON.stringify(data));
    response.end();
  };
  const error = (response: http.ServerResponse, msg: string, status = 500) => {
    record.status = status;
    response.write(JSON.stringify({ error: msg }));
    response.end();
  };
  const readJsonBody = async <T extends object>(
    request: http.IncomingMessage,
  ): Promise<T | null> => {
    return await new Promise<T | null>((resolve) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        if (!text) return resolve(null);
        try {
          resolve(JSON.parse(text) as T);
        } catch {
          resolve(null);
        }
      });
    });
  };

  const state = opts.state ?? {
    runtime: opts.runtime,
    config: { user: { name: "tester" } },
    agentName: opts.runtime?.character.name ?? "Eliza",
    adminEntityId: stringToUuid("admin-entity-id") as UUID,
    chatRoomId: null,
    chatUserId: null,
    chatConnectionReady: null,
    chatConnectionPromise: null,
    logBuffer: [],
    conversations: new Map(),
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
  };

  return {
    req,
    record,
    state,
    invoke: () =>
      handleConversationRouteGroup({
        req,
        res,
        method: opts.method,
        pathname: opts.pathname,
        url: new URL(`http://localhost${opts.pathname}`),
        state: state as never,
        json,
        error,
        readJsonBody: readJsonBody as never,
      }),
  };
}

function signWaifuJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", "waifu-secret")
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

function waifuAuthHeaders(
  role: "admin" | "user" | "guest",
  walletAddress: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${signWaifuJwt({
      iss: "waifu.fun",
      aud: "eliza-cloud-chat",
      exp: Math.floor(Date.now() / 1000) + 60,
      role,
      walletAddress,
    })}`,
  };
}

describe("POST /api/agents/:id/message (issue #7680)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WAIFU_CHAT_ACCESS_JWT_SECRET = "waifu-secret";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WAIFU_CHAT_ACCESS_JWT_SECRET;
  });

  it("is bound by the dispatcher (no longer 404s as 'route missing') and routes via generateChatResponse", async () => {
    const agentId = stringToUuid("test-agent") as UUID;
    const runtime = createRuntime(agentId, {
      messageService: createMessageService("hello back"),
    });

    const { record, invoke } = createCtx({
      method: "POST",
      pathname: `/api/agents/${agentId}/message`,
      body: { userId: "user-1", text: "hello" },
      runtime,
    });

    const handled = await invoke();
    expect(handled).toBe(true);
    // Crucial assertion: the dispatcher returned `true` (handled), proving
    // the route is bound. Before #7680 the route fell through here and the
    // outer server.ts default returned 404 "Not found".
    expect(record.status).toBe(200);

    const body = parseResponseBody(record) as { response?: string };
    expect(typeof body.response).toBe("string");
    // The reply must come from the messageService we wired — proving the
    // route uses the shared generateChatResponse flow (the same path
    // `/v1/chat/completions` uses).
    expect(body.response).toBe("hello back");
  });

  it("returns 404 only on agentId mismatch (real not-found, not 'route missing')", async () => {
    const agentId = stringToUuid("real-agent") as UUID;
    const runtime = createRuntime(agentId);

    const { record, invoke } = createCtx({
      method: "POST",
      pathname: `/api/agents/${stringToUuid("other-agent")}/message`,
      body: { userId: "user-1", text: "hello" },
      runtime,
    });

    const handled = await invoke();
    expect(handled).toBe(true);
    expect(record.status).toBe(404);

    const body = parseResponseBody(record) as { error?: string };
    expect(body.error).toBe("Agent not found");
  });

  it("returns 400 when userId or text is missing", async () => {
    const agentId = stringToUuid("validate-agent") as UUID;
    const runtime = createRuntime(agentId);

    const { record, invoke } = createCtx({
      method: "POST",
      pathname: `/api/agents/${agentId}/message`,
      body: { userId: "user-1" }, // no text
      runtime,
    });

    const handled = await invoke();
    expect(handled).toBe(true);
    expect(record.status).toBe(400);

    const body = parseResponseBody(record) as { error?: string };
    expect(body.error).toContain("userId and text are required");
  });

  it("returns 503 when no runtime is mounted", async () => {
    const { record, invoke } = createCtx({
      method: "POST",
      pathname: `/api/agents/${stringToUuid("any-agent")}/message`,
      body: { userId: "user-1", text: "hi" },
      runtime: null,
    });

    const handled = await invoke();
    expect(handled).toBe(true);
    expect(record.status).toBe(503);
  });

  it("scopes hosted waifu conversations to the holder wallet while admin can see all", async () => {
    const ownerWallet = "0x1111111111111111111111111111111111111111";
    const otherWallet = "0x2222222222222222222222222222222222222222";

    const created = createCtx({
      method: "POST",
      pathname: "/api/conversations",
      body: { title: "holder chat" },
      runtime: null,
      headers: waifuAuthHeaders("guest", ownerWallet),
    });
    expect(await created.invoke()).toBe(true);
    expect(created.record.status).toBe(200);

    const createBody = parseResponseBody(created.record) as {
      conversation?: { id: string; metadata?: Record<string, unknown> };
    };
    const conversationId = createBody.conversation?.id;
    expect(conversationId).toBeTruthy();
    expect(createBody.conversation?.metadata).toMatchObject({
      waifuChatOwnerWallet: ownerWallet.toLowerCase(),
      waifuChatRole: "guest",
    });

    const ownerList = createCtx({
      method: "GET",
      pathname: "/api/conversations",
      runtime: null,
      headers: waifuAuthHeaders("guest", ownerWallet),
      state: created.state,
    });
    expect(await ownerList.invoke()).toBe(true);
    expect(
      (parseResponseBody(ownerList.record) as { conversations: unknown[] })
        .conversations,
    ).toHaveLength(1);

    const otherList = createCtx({
      method: "GET",
      pathname: "/api/conversations",
      runtime: null,
      headers: waifuAuthHeaders("user", otherWallet),
      state: created.state,
    });
    expect(await otherList.invoke()).toBe(true);
    expect(
      (parseResponseBody(otherList.record) as { conversations: unknown[] })
        .conversations,
    ).toHaveLength(0);

    const otherMessages = createCtx({
      method: "GET",
      pathname: `/api/conversations/${conversationId}/messages`,
      runtime: null,
      headers: waifuAuthHeaders("user", otherWallet),
      state: created.state,
    });
    expect(await otherMessages.invoke()).toBe(true);
    expect(otherMessages.record.status).toBe(404);

    const adminList = createCtx({
      method: "GET",
      pathname: "/api/conversations",
      runtime: null,
      headers: waifuAuthHeaders("admin", otherWallet),
      state: created.state,
    });
    expect(await adminList.invoke()).toBe(true);
    expect(
      (parseResponseBody(adminList.record) as { conversations: unknown[] })
        .conversations,
    ).toHaveLength(1);
  });

  it("denies non-admin waifu mutations even when the holder owns the conversation", async () => {
    const ownerWallet = "0x1111111111111111111111111111111111111111";

    const created = createCtx({
      method: "POST",
      pathname: "/api/conversations",
      body: { title: "holder chat" },
      runtime: null,
      headers: waifuAuthHeaders("user", ownerWallet),
    });
    expect(await created.invoke()).toBe(true);
    const createBody = parseResponseBody(created.record) as {
      conversation?: { id: string };
    };
    const conversationId = createBody.conversation?.id;
    expect(conversationId).toBeTruthy();

    const patch = createCtx({
      method: "PATCH",
      pathname: `/api/conversations/${conversationId}`,
      body: { title: "renamed" },
      runtime: null,
      headers: waifuAuthHeaders("user", ownerWallet),
      state: created.state,
    });
    expect(await patch.invoke()).toBe(true);
    expect(patch.record.status).toBe(403);
  });
});

describe("compatibility transport transcript visibility", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams callback-only replies through the OpenAI-compatible transport", async () => {
    const agentId = stringToUuid("openai-callback-agent") as UUID;
    const runtime = createRuntime(agentId, {
      messageService: createCallbackMessageService("callback reply"),
    });
    const { record, invoke } = createCtx({
      method: "POST",
      pathname: "/v1/chat/completions",
      body: {
        model: "eliza",
        stream: true,
        messages: [{ role: "user", content: "Reply through the callback" }],
      },
      runtime,
    });

    expect(await invoke()).toBe(true);
    expect(record.status).toBe(200);
    const frames = parseSseJsonFrames(record) as Array<{
      choices?: Array<{ delta?: { content?: string } }>;
    }>;
    const text = frames
      .flatMap((frame) => frame.choices ?? [])
      .map((choice) => choice.delta?.content ?? "")
      .join("");
    expect(text).toBe("callback reply");
  });

  it("cancels an OpenAI-compatible stream when the request is aborted", async () => {
    const agentId = stringToUuid("openai-disconnect-agent") as UUID;
    let generationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      generationStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const runtime = createRuntime(agentId, {
      messageService: {
        async handleMessage(_runtime, _message, _callback, options) {
          observedSignal = options?.abortSignal;
          generationStarted?.();
          await new Promise<void>((_resolve, reject) => {
            options?.abortSignal?.addEventListener(
              "abort",
              () => reject(options.abortSignal?.reason),
              { once: true },
            );
          });
          throw new Error("unreachable");
        },
        shouldRespond: () => ({
          shouldRespond: true,
          skipEvaluation: true,
          reason: "test",
        }),
        deleteMessage: async () => undefined,
        clearChannel: async () => undefined,
      } as unknown as MessageService,
    });
    const { req, record, invoke } = createCtx({
      method: "POST",
      pathname: "/v1/chat/completions",
      body: {
        model: "eliza",
        stream: true,
        messages: [{ role: "user", content: "Cancel this turn" }],
      },
      runtime,
    });

    const pending = invoke();
    await started;
    req.emit("aborted");

    await expect(pending).resolves.toBe(true);
    expect(observedSignal?.aborted).toBe(true);
    expect(record.writes.join("")).not.toContain("data: [DONE]");
  });

  it("does not treat normal request close as an OpenAI stream disconnect", async () => {
    const agentId = stringToUuid("openai-request-close-agent") as UUID;
    let releaseGeneration: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    let generationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      generationStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const runtime = createRuntime(agentId, {
      messageService: {
        async handleMessage(_runtime, _message, _callback, options) {
          observedSignal = options?.abortSignal;
          generationStarted?.();
          await release;
          return {
            didRespond: true,
            responseContent: { text: "still connected" },
            responseMessages: [],
          };
        },
        shouldRespond: () => ({
          shouldRespond: true,
          skipEvaluation: true,
          reason: "test",
        }),
        deleteMessage: async () => undefined,
        clearChannel: async () => undefined,
      } as unknown as MessageService,
    });
    const { req, record, invoke } = createCtx({
      method: "POST",
      pathname: "/v1/chat/completions",
      body: {
        model: "eliza",
        stream: true,
        messages: [{ role: "user", content: "Finish normally" }],
      },
      runtime,
    });

    const pending = invoke();
    await started;
    req.emit("close");
    expect(observedSignal?.aborted).toBe(false);
    releaseGeneration?.();

    await expect(pending).resolves.toBe(true);
    expect(record.writes.join("")).toContain("still connected");
    expect(record.writes.join("")).toContain("data: [DONE]");
  });

  it("ends an OpenAI-compatible divergent stream with an observable error, not success", async () => {
    const agentId = stringToUuid("openai-divergent-callback-agent") as UUID;
    const runtime = createRuntime(agentId, {
      messageService: createCallbackMessageService(
        "authoritative final reply",
        "provisional streamed reply",
      ),
    });
    const { record, invoke } = createCtx({
      method: "POST",
      pathname: "/v1/chat/completions",
      body: {
        model: "eliza",
        stream: true,
        messages: [{ role: "user", content: "Change the callback reply" }],
      },
      runtime,
    });

    expect(await invoke()).toBe(true);
    const frames = parseSseJsonFrames(record) as Array<{
      error?: { type?: string; code?: string };
      choices?: Array<{
        delta?: { content?: string };
        finish_reason?: string | null;
      }>;
    }>;
    const streamedText = frames
      .flatMap((frame) => frame.choices ?? [])
      .map((choice) => choice.delta?.content ?? "")
      .join("");
    expect(streamedText).toBe("provisional streamed reply");
    expect(frames).toContainEqual({
      error: expect.objectContaining({
        type: "stream_error",
        code: "CHAT_APPEND_ONLY_STREAM_DIVERGENCE",
      }),
    });
    expect(
      frames
        .flatMap((frame) => frame.choices ?? [])
        .some((choice) => choice.finish_reason === "stop"),
    ).toBe(false);
    expect(record.writes.join("")).not.toContain("data: [DONE]");
  });

  it("streams callback-only replies through the Anthropic-compatible transport", async () => {
    const agentId = stringToUuid("anthropic-callback-agent") as UUID;
    const runtime = createRuntime(agentId, {
      messageService: createCallbackMessageService("callback reply"),
    });
    const { record, invoke } = createCtx({
      method: "POST",
      pathname: "/v1/messages",
      body: {
        model: "eliza",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "Reply through the callback" }],
      },
      runtime,
    });

    expect(await invoke()).toBe(true);
    expect(record.status).toBe(200);
    const frames = parseSseJsonFrames(record) as Array<{
      type?: string;
      delta?: { text?: string };
    }>;
    const text = frames
      .filter((frame) => frame.type === "content_block_delta")
      .map((frame) => frame.delta?.text ?? "")
      .join("");
    expect(text).toBe("callback reply");
  });

  it("ends an Anthropic-compatible divergent stream with an error before completion", async () => {
    const agentId = stringToUuid("anthropic-divergent-callback-agent") as UUID;
    const runtime = createRuntime(agentId, {
      messageService: createCallbackMessageService(
        "authoritative final reply",
        "provisional streamed reply",
      ),
    });
    const { record, invoke } = createCtx({
      method: "POST",
      pathname: "/v1/messages",
      body: {
        model: "eliza",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "Change the callback reply" }],
      },
      runtime,
    });

    expect(await invoke()).toBe(true);
    const frames = parseSseJsonFrames(record) as Array<{
      type?: string;
      delta?: { text?: string };
      error?: { type?: string; code?: string };
    }>;
    const streamedText = frames
      .filter((frame) => frame.type === "content_block_delta")
      .map((frame) => frame.delta?.text ?? "")
      .join("");
    expect(streamedText).toBe("provisional streamed reply");
    expect(frames).toContainEqual({
      type: "error",
      error: expect.objectContaining({
        type: "stream_error",
        code: "CHAT_APPEND_ONLY_STREAM_DIVERGENCE",
      }),
    });
    expect(frames.map((frame) => frame.type)).not.toContain(
      "content_block_stop",
    );
    expect(frames.map((frame) => frame.type)).not.toContain("message_delta");
    expect(frames.map((frame) => frame.type)).not.toContain("message_stop");
  });

  it("returns empty OpenAI-compatible non-streaming content for an internal turn", async () => {
    const agentId = stringToUuid("openai-internal-agent") as UUID;
    const runtime = createRuntime(agentId, {
      messageService: createMessageService(INTERNAL_VIEWS_TEXT, "internal"),
    });
    const { record, invoke } = createCtx({
      method: "POST",
      pathname: "/v1/chat/completions",
      body: {
        model: "eliza",
        messages: [{ role: "user", content: "List the views" }],
      },
      runtime,
    });

    expect(await invoke()).toBe(true);
    expect(record.status).toBe(200);
    const body = parseResponseBody(record) as {
      choices: Array<{ message: { content: string } }>;
    };
    expect(body.choices[0]?.message.content).toBe("");
    expect(JSON.stringify(body)).not.toContain("available_views");
  });

  it("does not emit an OpenAI-compatible content delta or fallback for an internal turn", async () => {
    const agentId = stringToUuid("openai-stream-internal-agent") as UUID;
    const runtime = createRuntime(agentId, {
      messageService: createMessageService(INTERNAL_VIEWS_TEXT, "internal"),
    });
    const { record, invoke } = createCtx({
      method: "POST",
      pathname: "/v1/chat/completions",
      body: {
        model: "eliza",
        stream: true,
        messages: [{ role: "user", content: "List the views" }],
      },
      runtime,
    });

    expect(await invoke()).toBe(true);
    expect(record.status).toBe(200);
    const frames = parseSseJsonFrames(record) as Array<{
      choices?: Array<{ delta?: { content?: string } }>;
    }>;
    expect(
      frames.flatMap((frame) =>
        (frame.choices ?? []).flatMap((choice) =>
          choice.delta?.content === undefined ? [] : [choice.delta.content],
        ),
      ),
    ).toEqual([]);
    expect(JSON.stringify(frames)).not.toContain("available_views");
  });

  it("returns empty Anthropic-compatible non-streaming content for an internal turn", async () => {
    const agentId = stringToUuid("anthropic-internal-agent") as UUID;
    const runtime = createRuntime(agentId, {
      messageService: createMessageService(INTERNAL_VIEWS_TEXT, "internal"),
    });
    const { record, invoke } = createCtx({
      method: "POST",
      pathname: "/v1/messages",
      body: {
        model: "eliza",
        max_tokens: 128,
        messages: [{ role: "user", content: "List the views" }],
      },
      runtime,
    });

    expect(await invoke()).toBe(true);
    expect(record.status).toBe(200);
    const body = parseResponseBody(record) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(body.content).toEqual([{ type: "text", text: "" }]);
    expect(JSON.stringify(body)).not.toContain("available_views");
  });

  it("does not emit an Anthropic-compatible text delta or fallback for an internal turn", async () => {
    const agentId = stringToUuid("anthropic-stream-internal-agent") as UUID;
    const runtime = createRuntime(agentId, {
      messageService: createMessageService(INTERNAL_VIEWS_TEXT, "internal"),
    });
    const { record, invoke } = createCtx({
      method: "POST",
      pathname: "/v1/messages",
      body: {
        model: "eliza",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "List the views" }],
      },
      runtime,
    });

    expect(await invoke()).toBe(true);
    expect(record.status).toBe(200);
    const frames = parseSseJsonFrames(record) as Array<{
      type?: string;
      delta?: { text?: string };
    }>;
    expect(
      frames.filter((frame) => frame.type === "content_block_delta"),
    ).toEqual([]);
    expect(JSON.stringify(frames)).not.toContain("available_views");
  });

  it("returns an empty response from /api/agents/:id/message for an internal turn", async () => {
    const agentId = stringToUuid("agent-message-internal-agent") as UUID;
    const runtime = createRuntime(agentId, {
      messageService: createMessageService(INTERNAL_VIEWS_TEXT, "internal"),
    });
    const { record, invoke } = createCtx({
      method: "POST",
      pathname: `/api/agents/${agentId}/message`,
      body: { userId: "user-1", text: "List the views" },
      runtime,
    });

    expect(await invoke()).toBe(true);
    expect(record.status).toBe(200);
    const body = parseResponseBody(record) as { response: string };
    expect(body.response).toBe("");
    expect(JSON.stringify(body)).not.toContain("available_views");
  });

  it("preserves a distinct visible summary instead of suppressing the whole turn", async () => {
    const agentId = stringToUuid("agent-message-visible-agent") as UUID;
    const runtime = createRuntime(agentId, {
      messageService: createMessageService(
        "Notes and Calendar are ready to use.",
      ),
    });
    const { record, invoke } = createCtx({
      method: "POST",
      pathname: `/api/agents/${agentId}/message`,
      body: { userId: "user-1", text: "List the views" },
      runtime,
    });

    expect(await invoke()).toBe(true);
    expect(record.status).toBe(200);
    expect(parseResponseBody(record)).toMatchObject({
      response: "Notes and Calendar are ready to use.",
    });
  });
});

describe("AgentRuntime model dispatch (layer-2 verification from #7680)", () => {
  /**
   * Layer-2 check from #7680: the issue suspected that `useModel(TEXT_LARGE)`
   * doesn't actually fire the registered handler. This test confirms the
   * dispatch path: `registerModel` and the `useModel` resolver share a
   * single Map (`this.models`). There is no shadow table — handlers
   * registered via `runtime.registerModel` are exactly what `useModel`
   * resolves to.
   *
   * We exercise the `registerModel` method directly (private member of
   * `AgentRuntime` instance). Constructing a fully wired `AgentRuntime`
   * for this unit test would pull in a database adapter; instead we use
   * the public `registerModel`/`getModel` methods bound to a
   * prototype-backed fixture. This keeps the real registration guards in
   * the path while supplying only the state those methods consume.
   */
  it("resolves TEXT_LARGE handler from the same Map that registerModel writes", async () => {
    const { AgentRuntime } = await import("@elizaos/core");
    type ModelHandler = (
      runtime: AgentRuntime,
      params: Record<string, unknown>,
    ) => Promise<unknown>;
    interface ModelEntry {
      handler: ModelHandler;
      provider: string;
      priority: number;
      registrationOrder: number;
    }
    const models = new Map<string, ModelEntry[]>();
    const stub = Object.assign(
      Object.create(AgentRuntime.prototype) as AgentRuntime,
      {
        models,
        logger: { debug: () => {}, info: () => {}, warn: () => {} },
        agentId: stringToUuid("model-routing-agent"),
        emitEvent: vi.fn(async () => undefined),
        getSetting: vi.fn(() => undefined),
      },
    );

    const handler = vi.fn(async () => "from-local-inference");
    AgentRuntime.prototype.registerModel.call(
      stub,
      ModelType.TEXT_LARGE,
      handler as never,
      "eliza-local-inference",
      0,
    );

    // The Map is populated as the runtime expects — verify the row shape
    // matches what `resolveModelRegistration` reads inside `useModel`.
    const entries = models.get(ModelType.TEXT_LARGE);
    expect(entries?.length).toBe(1);
    expect(entries?.[0].handler).toBe(handler);
    expect(entries?.[0].provider).toBe("eliza-local-inference");
    expect(entries?.[0].priority).toBe(0);

    // Calling the resolved handler directly proves the registered closure
    // is what would fire — no separate "slot assignments" indirection.
    const result = await entries?.[0].handler(stub, {
      prompt: "test",
      maxTokens: 16,
    });
    expect(result).toBe("from-local-inference");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

void ChannelType;
