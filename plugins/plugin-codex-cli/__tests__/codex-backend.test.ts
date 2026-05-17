import { afterEach, describe, expect, it } from "vitest";
import {
  __resetCodexAuthDeps,
  __setCodexAuthDeps,
  type CodexAuth,
  isExpired,
} from "../src/codex-auth";
import { CodexBackend, translateMessagesToCodexInput } from "../src/codex-backend";
import { parseSSE } from "../src/sse-parser";
import { toOpenAITool } from "../src/tool-format-openai";

function jwtWithExp(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `x.${payload}.y`;
}

function sseResponse(events: string[]): Response {
  return new Response(events.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

const auth: CodexAuth = {
  OPENAI_API_KEY: null,
  auth_mode: "chatgpt",
  last_refresh: "2026-01-01T00:00:00.000Z",
  tokens: {
    id_token: "id",
    access_token: "access",
    refresh_token: "refresh",
    account_id: "acct_123",
  },
};

describe("codex auth helpers", () => {
  afterEach(() => __resetCodexAuthDeps());

  it("detects expired JWT access tokens with a buffer", () => {
    __setCodexAuthDeps({ now: () => 1_000_000 });
    expect(isExpired({ ...auth, tokens: { ...auth.tokens, access_token: jwtWithExp(900) } })).toBe(
      true
    );
    expect(
      isExpired({ ...auth, tokens: { ...auth.tokens, access_token: jwtWithExp(2_000) } })
    ).toBe(false);
  });
});

describe("SSE parser", () => {
  it("parses named events with multiline data", async () => {
    const stream = new Response(
      'event: response.output_text.delta\ndata: {"delta":"hel"}\ndata: {"delta":"lo"}\n\n'
    ).body;
    expect(stream).toBeTruthy();
    const events = [];
    for await (const event of parseSSE(stream as ReadableStream<Uint8Array>)) events.push(event);
    expect(events).toEqual([
      {
        event: "response.output_text.delta",
        data: '{"delta":"hel"}\n{"delta":"lo"}',
      },
    ]);
  });
});

describe("tool translation", () => {
  it("converts eliza tool definitions to OpenAI Responses function tools", () => {
    expect(
      toOpenAITool({
        name: "search",
        description: "Search the web",
        parameters: { type: "object", properties: { q: { type: "string" } } },
      })
    ).toEqual({
      type: "function",
      name: "search",
      description: "Search the web",
      parameters: { type: "object", properties: { q: { type: "string" } } },
      strict: false,
    });
  });
});

describe("CodexBackend", () => {
  it("translates provider-neutral messages and tool calls", () => {
    expect(
      translateMessagesToCodexInput(
        [
          { role: "system", content: "ignore me here" },
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_1", name: "lookup", arguments: { q: "x" } }],
          },
          { role: "tool", toolCallId: "call_1", content: "result" },
        ],
        "fallback"
      )
    ).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"q":"x"}' },
      { type: "function_call_output", call_id: "call_1", output: "result" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "fallback" }] },
    ]);
  });

  it("posts codex headers, parses text and function calls", async () => {
    const bodies: unknown[] = [];
    const backend = new CodexBackend({
      authPath: "/tmp/auth.json",
      jitterMaxMs: 0,
      loadAuth: async () => auth,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer access");
        expect((init?.headers as Record<string, string>)["chatgpt-account-id"]).toBe("acct_123");
        expect((init?.headers as Record<string, string>).originator).toBe("codex_cli_rs");
        return sseResponse([
          'event: response.output_text.delta\ndata: {"delta":"hi"}\n\n',
          'event: response.output_item.added\ndata: {"item":{"id":"item_1","type":"function_call","call_id":"call_1","name":"lookup"}}\n\n',
          'event: response.function_call_arguments.delta\ndata: {"item_id":"item_1","delta":"{\\"q\\":"}\n\n',
          'event: response.output_item.done\ndata: {"item":{"id":"item_1","type":"function_call","call_id":"call_1","name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}\n\n',
          'event: response.completed\ndata: {"response":{"stop_reason":"tool_calls","usage":{"input_tokens":3,"output_tokens":4}}}\n\n',
        ]);
      }) as typeof fetch,
    });

    const result = await backend.generate({
      prompt: "hello",
      tools: [{ name: "lookup", parameters: { type: "object" } }],
      toolChoice: { name: "lookup" },
    });

    expect(result).toEqual({
      text: "hi",
      toolCalls: [{ id: "call_1", name: "lookup", arguments: { q: "x" }, type: "function" }],
      finishReason: "tool_calls",
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });
    expect(bodies[0]).toMatchObject({
      model: "gpt-5.5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
      tools: [{ type: "function", name: "lookup" }],
      tool_choice: { type: "function", name: "lookup" },
    });
  });
});
