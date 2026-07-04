/**
 * Unit coverage for the Codex provider: plugin model metadata, JWT expiry, the
 * SSE parser, tool-schema translation, and CodexBackend request/stream handling
 * driven by a fake fetch (no live model or network).
 */
import { afterEach, describe, expect, it } from "vitest";
import { __INTERNAL_buildCodexGenerateParams, codexCliPlugin } from "../index";
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

describe("codex plugin metadata", () => {
  it("declares CODEX_MODEL as display metadata for every model handler", () => {
    const modelTypes = Object.keys(codexCliPlugin.models ?? {});
    expect(modelTypes.length).toBeGreaterThan(0);
    expect(Object.keys(codexCliPlugin.modelMetadata ?? {}).sort()).toEqual(modelTypes.sort());
    for (const modelType of modelTypes) {
      expect(codexCliPlugin.modelMetadata?.[modelType]).toEqual({
        displayModelSetting: "CODEX_MODEL",
      });
    }
  });
});

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

  it("normalizes strict tool schemas (codex backend 400s on partial required / missing additionalProperties)", () => {
    const out = toOpenAITool({
      name: "TASKS",
      description: "spawn/list coding sub-agents",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["create", "list"] },
          prompt: { type: "string" },
        },
        required: ["action"],
      },
    });
    expect(out.strict).toBe(true);
    // required must list EVERY property, additionalProperties:false, and the
    // originally-optional `prompt` is made nullable to keep its optional meaning.
    expect(out.parameters).toEqual({
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "list"] },
        prompt: { type: ["string", "null"] },
      },
      required: ["action", "prompt"],
      additionalProperties: false,
    });
  });
});

describe("CodexBackend", () => {
  it("honors a per-call model override before Codex slot defaults", () => {
    const runtime = {
      getSetting(key: string) {
        if (key === "CODEX_MODEL") return "gpt-5.5";
        return undefined;
      },
    };

    expect(
      __INTERNAL_buildCodexGenerateParams(runtime as never, {
        prompt: "hello",
        model: " gpt-5-codex ",
      }).model
    ).toBe("gpt-5-codex");
  });

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

  it("preserves tool-call and tool-result CONTENT PARTS (the planner's transcript format)", () => {
    // The planner renders prior steps as `tool-call` / `tool-result` content
    // parts, NOT the `toolCalls` field + plain-text tool message. Dropping
    // these made codex blind to its own fetches ("I don't have the fetched
    // contents visible here") and re-issue the same call in a loop.
    expect(
      translateMessagesToCodexInput(
        [
          { role: "user", content: "newest nodejs version?" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Fetching the dist index." },
              {
                type: "tool-call",
                toolCallId: "call_1",
                toolName: "WEB_FETCH",
                input: { url: "https://nodejs.org/dist/index.json" },
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call_1",
                toolName: "WEB_FETCH",
                output: { type: "text", value: 'text: [{"version":"v26.3.1"}]' },
              },
            ],
          },
        ],
        "newest nodejs version?"
      )
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "newest nodejs version?" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Fetching the dist index." }],
      },
      {
        type: "function_call",
        call_id: "call_1",
        name: "WEB_FETCH",
        arguments: '{"url":"https://nodejs.org/dist/index.json"}',
      },
      { type: "function_call_output", call_id: "call_1", output: 'text: [{"version":"v26.3.1"}]' },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "newest nodejs version?" }],
      },
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

  it("never forwards temperature or max_output_tokens (the codex backend 400s on them)", async () => {
    const bodies: unknown[] = [];
    const backend = new CodexBackend({
      authPath: "/tmp/auth.json",
      jitterMaxMs: 0,
      loadAuth: async () => auth,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return sseResponse([
          'event: response.output_text.delta\ndata: {"delta":"ok"}\n\n',
          'event: response.completed\ndata: {"response":{"stop_reason":"stop","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        ]);
      }) as typeof fetch,
    });

    // The runtime's planner/response-handler calls always pass maxTokens (and
    // often temperature); the ChatGPT codex backend rejects both with a 400
    // "Unsupported parameter", which previously emptied every codex turn.
    await backend.generate({ prompt: "hi", temperature: 0.7, maxTokens: 2048 });

    const body = bodies[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_output_tokens");
  });
});
