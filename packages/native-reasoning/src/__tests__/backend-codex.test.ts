/**
 * Wave B tests — CodexBackend with mocked fetch + auth helpers.
 *
 * We never touch the real filesystem or the real network: the test config
 * always injects `loadAuth`, `refreshAuth`, and `fetchImpl`. Stream bodies
 * are constructed via `ReadableStream` from canned SSE event sequences.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CodexBackend,
  translateMessagesToCodexInput,
} from "../backends/codex.js";
import type { CallTurnOptions, TurnMessage } from "../backends/types.js";
import type { NativeTool } from "../tool-schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sseEvent(eventName: string, data: unknown): string {
  return `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeStreamBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i] as string));
      i++;
    },
  });
}

function okResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/event-stream" },
  });
}

function fakeAuth(access = "tok-1") {
  return {
    OPENAI_API_KEY: null,
    auth_mode: "chatgpt" as const,
    last_refresh: "2026-01-01T00:00:00Z",
    tokens: {
      access_token: access,
      refresh_token: "ref-1",
      account_id: "acct-1",
      id_token: "idtok",
    },
  };
}

const baseOpts = (
  overrides: Partial<CallTurnOptions> = {},
): CallTurnOptions => ({
  systemPrompt: "you are a test agent",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    },
  ],
  tools: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("translateMessagesToCodexInput", () => {
  it("translates user/assistant/tool turns into codex input shape", () => {
    const messages: TurnMessage[] = [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          {
            type: "tool_use",
            id: "call-1",
            name: "bash",
            input: { cmd: "ls" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "file.txt",
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const out = translateMessagesToCodexInput(messages);
    expect(out).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "let me check" }],
      },
      {
        type: "function_call",
        call_id: "call-1",
        name: "bash",
        arguments: '{"cmd":"ls"}',
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "file.txt",
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    ]);
  });

  it("translates user-role tool_result blocks (anthropic-style) to function_call_output", () => {
    const messages: TurnMessage[] = [
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-9",
            content: "ok",
          },
        ],
      },
    ];
    const out = translateMessagesToCodexInput(messages);
    expect(out).toEqual([
      {
        type: "function_call_output",
        call_id: "call-9",
        output: "ok",
      },
    ]);
  });
});

describe("CodexBackend.callTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns accumulated text on a simple reply", async () => {
    const sse = [
      sseEvent("response.created", { sequence_number: 1 }),
      sseEvent("response.in_progress", { sequence_number: 2 }),
      sseEvent("response.output_item.added", {
        sequence_number: 3,
        item: { type: "message", role: "assistant", id: "msg-1" },
      }),
      sseEvent("response.content_part.added", { sequence_number: 4 }),
      sseEvent("response.output_text.delta", {
        sequence_number: 5,
        delta: "Hello, ",
      }),
      sseEvent("response.output_text.delta", {
        sequence_number: 6,
        delta: "world!",
      }),
      sseEvent("response.output_text.done", { sequence_number: 7 }),
      sseEvent("response.output_item.done", { sequence_number: 8 }),
      sseEvent("response.completed", {
        sequence_number: 9,
        response: {
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            total_tokens: 13,
          },
        },
      }),
    ];
    const fetchImpl = vi.fn(async () => okResponse(makeStreamBody(sse))) as any;
    const be = new CodexBackend({
      fetchImpl,
      loadAuth: async () => fakeAuth() as any,
      refreshAuth: async () => fakeAuth("tok-2") as any,
      jitterMaxMs: 0,
    });
    const result = await be.callTurn(baseOpts());
    expect(result.text).toBe("Hello, world!");
    expect(result.toolCalls).toEqual([]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage?.input).toBe(10);
    expect(result.usage?.output).toBe(3);
    expect(result.rawAssistantBlocks).toEqual([
      { type: "text", text: "Hello, world!" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toMatch(/\/responses$/);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-1");
    expect(headers["chatgpt-account-id"]).toBe("acct-1");
    expect(headers.originator).toBe("codex_cli_rs");
    expect(headers["OpenAI-Beta"]).toBe("responses=v1");
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers["User-Agent"]).toMatch(/^codex_cli_rs\//);
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.instructions).toBe("you are a test agent");
    expect(body.input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    });
  });

  it("captures a function_call across delta events", async () => {
    const sse = [
      sseEvent("response.created", { sequence_number: 1 }),
      sseEvent("response.output_item.added", {
        sequence_number: 2,
        item: {
          type: "function_call",
          id: "fc-item-1",
          call_id: "call-abc",
          name: "bash",
          arguments: "",
        },
      }),
      sseEvent("response.function_call_arguments.delta", {
        sequence_number: 3,
        item_id: "fc-item-1",
        delta: '{"cmd":',
      }),
      sseEvent("response.function_call_arguments.delta", {
        sequence_number: 4,
        item_id: "fc-item-1",
        delta: '"ls"}',
      }),
      sseEvent("response.output_item.done", {
        sequence_number: 5,
        item: {
          type: "function_call",
          id: "fc-item-1",
          call_id: "call-abc",
          name: "bash",
          arguments: '{"cmd":"ls"}',
        },
      }),
      sseEvent("response.completed", {
        sequence_number: 6,
        response: { usage: { input_tokens: 1, output_tokens: 1 } },
      }),
    ];
    const fetchImpl = vi.fn(async () => okResponse(makeStreamBody(sse))) as any;
    const tool: NativeTool = {
      type: "custom",
      name: "bash",
      description: "run shell",
      input_schema: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    };
    const be = new CodexBackend({
      fetchImpl,
      loadAuth: async () => fakeAuth() as any,
      refreshAuth: async () => fakeAuth() as any,
      jitterMaxMs: 0,
    });
    const result = await be.callTurn(baseOpts({ tools: [tool] }));
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      id: "call-abc",
      name: "bash",
      input: { cmd: "ls" },
    });
    expect(result.rawAssistantBlocks).toEqual([
      {
        type: "tool_use",
        id: "call-abc",
        name: "bash",
        input: { cmd: "ls" },
      },
    ]);
    // Tools converted into openai function shape on the wire.
    const sentBody = JSON.parse(fetchImpl.mock.calls[0]![1].body as string);
    expect(sentBody.tools).toEqual([
      {
        type: "function",
        name: "bash",
        description: "run shell",
        parameters: tool.input_schema,
        strict: false,
      },
    ]);
  });

  it("refreshes OAuth on 401 and retries once", async () => {
    const sseOk = [
      sseEvent("response.completed", {
        sequence_number: 1,
        response: { usage: {} },
      }),
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("unauthorized", {
          status: 401,
          statusText: "Unauthorized",
        }),
      )
      .mockResolvedValueOnce(okResponse(makeStreamBody(sseOk))) as any;
    const refreshAuth = vi.fn(async () => fakeAuth("tok-2") as any);
    const loadAuth = vi.fn(async () => fakeAuth("tok-1") as any);
    const be = new CodexBackend({
      fetchImpl,
      loadAuth,
      refreshAuth,
      jitterMaxMs: 0,
    });
    const result = await be.callTurn(baseOpts());
    expect(result.text).toBe("");
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const auth1 = (fetchImpl.mock.calls[0]![1].headers as any)
      .Authorization as string;
    const auth2 = (fetchImpl.mock.calls[1]![1].headers as any)
      .Authorization as string;
    expect(auth1).toBe("Bearer tok-1");
    expect(auth2).toBe("Bearer tok-2");
  });

  it("throws on response.failed with the error code in the message", async () => {
    const sse = [
      sseEvent("response.created", { sequence_number: 1 }),
      sseEvent("response.failed", {
        sequence_number: 2,
        response: {
          error: { code: "rate_limited", message: "slow down" },
        },
      }),
    ];
    const fetchImpl = vi.fn(async () => okResponse(makeStreamBody(sse))) as any;
    const be = new CodexBackend({
      fetchImpl,
      loadAuth: async () => fakeAuth() as any,
      refreshAuth: async () => fakeAuth() as any,
      jitterMaxMs: 0,
    });
    await expect(be.callTurn(baseOpts())).rejects.toThrow(/rate_limited/);
  });

  it("honors AbortSignal during streaming", async () => {
    const enc = new TextEncoder();
    // Stream that never closes on its own — the abort should cancel it.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          enc.encode(sseEvent("response.created", { sequence_number: 1 })),
        );
      },
    });
    const fetchImpl = vi.fn(async () => okResponse(stream)) as any;
    const be = new CodexBackend({
      fetchImpl,
      loadAuth: async () => fakeAuth() as any,
      refreshAuth: async () => fakeAuth() as any,
      jitterMaxMs: 0,
    });
    const ctrl = new AbortController();
    const p = be.callTurn(baseOpts({ abortSignal: ctrl.signal }));
    // Abort shortly after kicking off so we see the abort path.
    setTimeout(() => ctrl.abort(), 20);
    await expect(p).rejects.toThrow();
  });

  it("propagates non-401 HTTP errors with status + body", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("nope", { status: 500, statusText: "Boom" }),
    ) as any;
    const be = new CodexBackend({
      fetchImpl,
      loadAuth: async () => fakeAuth() as any,
      refreshAuth: async () => fakeAuth() as any,
      jitterMaxMs: 0,
    });
    await expect(be.callTurn(baseOpts())).rejects.toThrow(/500.*nope/s);
  });

  it("serializes concurrent callTurn calls (single in-flight at a time)", async () => {
    const sse = [
      sseEvent("response.completed", {
        sequence_number: 1,
        response: { usage: {} },
      }),
    ];
    let inflight = 0;
    let maxInflight = 0;
    const fetchImpl = vi.fn(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      // Simulate a small in-flight window.
      await new Promise((r) => setTimeout(r, 10));
      inflight--;
      return okResponse(makeStreamBody(sse));
    }) as any;
    const be = new CodexBackend({
      fetchImpl,
      loadAuth: async () => fakeAuth() as any,
      refreshAuth: async () => fakeAuth() as any,
      jitterMaxMs: 0,
    });
    await Promise.all([
      be.callTurn(baseOpts()),
      be.callTurn(baseOpts()),
      be.callTurn(baseOpts()),
    ]);
    expect(maxInflight).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("survives an error mid-chain and still allows subsequent calls", async () => {
    const sseOk = [
      sseEvent("response.completed", {
        sequence_number: 1,
        response: { usage: {} },
      }),
    ];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("kaboom", { status: 502, statusText: "Bad Gateway" }),
      )
      .mockResolvedValueOnce(okResponse(makeStreamBody(sseOk))) as any;
    const be = new CodexBackend({
      fetchImpl,
      loadAuth: async () => fakeAuth() as any,
      refreshAuth: async () => fakeAuth() as any,
      jitterMaxMs: 0,
    });
    await expect(be.callTurn(baseOpts())).rejects.toThrow(/502/);
    // Second call should still go through (semaphore unblocked).
    const r = await be.callTurn(baseOpts());
    expect(r.text).toBe("");
  });
});
