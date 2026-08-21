/**
 * Wire-boundary regression for #18025: requests built by the text handlers
 * must serialize to well-formed strict JSON even when upstream text carries
 * lone UTF-16 surrogates (a mid-emoji `.slice()` leaves a lone leading
 * surrogate that `JSON.stringify` emits as a bare `\uD8xx` escape — Cerebras
 * rejects that body with `{"message":": Invalid JSON: lone leading surrogate
 * in hex escape...","code":"wrong_api_format"}`). Real `ai` SDK and real
 * client factory against a loopback chat-completions server that captures the
 * raw request bytes; the assertions replay a strict parser's view of the body.
 */
import { createServer, type Server } from "node:http";
import { type ElizaError, type IAgentRuntime, MAX_WELL_FORMED_VISITS } from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTextSmall } from "../models";

/** JSON.stringify only escapes surrogate code units when they are lone; a
 * well-formed body therefore contains no \ud800-\udfff escape at all. */
const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

interface CapturedRequest {
  url: string;
  bytes: Buffer;
}

const captured: CapturedRequest[] = [];
let server: Server;
let baseUrl: string;

function startCaptureServer(): Promise<string> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      captured.push({ url: request.url ?? "", bytes: Buffer.from(raw, "utf8") });
      response.writeHead(200, { "content-type": "application/json" });
      // When the request includes response_format (structured output), the AI
      // SDK parses the response content as JSON; return valid JSON for those.
      const hasStructuredOutput = raw.includes("response_format");
      const content = hasStructuredOutput ? JSON.stringify({ goodField: "value" }) : "ok";
      response.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          created: 0,
          model: "test-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("capture server did not bind a TCP port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}/v1`);
    });
  });
}

function buildRuntime(): IAgentRuntime {
  return {
    // Fall through to the stubbed env for every setting.
    getSetting: vi.fn(() => undefined),
    character: { name: "Ada", system: "You are Ada \uD83D" },
    emitEvent: vi.fn(),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
  } as unknown as IAgentRuntime;
}

/** Strict-parser view of the captured body: fatal UTF-8 decode, full-body
 * well-formedness, no lone-surrogate escapes, and a successful JSON.parse. */
function assertStrictParseable(bytes: Buffer): Record<string, unknown> {
  const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
  expect(LONE_SURROGATE_ESCAPE.test(body)).toBe(false);
  return JSON.parse(body) as Record<string, unknown>;
}

beforeAll(async () => {
  baseUrl = await startCaptureServer();
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  captured.length = 0;
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_BASE_URL", baseUrl);
  vi.stubEnv("OPENAI_SMALL_MODEL", "test-model");
  vi.stubEnv("CEREBRAS_API_KEY", undefined);
  vi.stubEnv("ELIZA_PROVIDER", undefined);
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", undefined);
});

describe("#18025: request bodies are well-formed strict JSON", () => {
  it("rejects an oversized sparse response schema before opening a provider request", async () => {
    const sparseSchema = new Array(MAX_WELL_FORMED_VISITS);

    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "return structured data",
        responseSchema: sparseSchema,
      } as never)
    ).rejects.toMatchObject({
      code: "WELL_FORMED_UNBOUNDED",
      context: { reason: "visits" },
    } satisfies Partial<ElizaError>);
    expect(captured).toHaveLength(0);
  });

  it("sanitizes a prompt truncated mid-emoji (lone leading surrogate)", async () => {
    const brokenPrompt = "summarize this page 🤖 please".slice(0, 21); // splits 🤖
    expect(LONE_SURROGATE_ESCAPE.test(JSON.stringify(brokenPrompt))).toBe(true);

    const result = await handleTextSmall(buildRuntime(), { prompt: brokenPrompt } as never);
    expect(result).toBe("ok");

    expect(captured).toHaveLength(1);
    const body = assertStrictParseable(captured[0].bytes);
    const messages = body.messages as Array<{ role: string; content: string }>;
    const user = messages.find((message) => message.role === "user");
    expect(user?.content).toBe("summarize this page �");
    // The lone surrogate in the character's system prompt is sanitized too.
    const system = messages.find((message) => message.role === "system");
    expect(system?.content).toContain("You are Ada �");
  });

  it("sanitizes the post-tool evaluator shape: assistant tool_calls + tool result content", async () => {
    const loneInToolResult = `fetched: emoji heavy 💀🔥 page…`.slice(0, 22); // splits 💀
    const loneInToolArgs = "🔥".slice(0, 1);

    const result = await handleTextSmall(buildRuntime(), {
      messages: [
        { role: "system", content: "evaluate the tool turn" },
        { role: "user", content: "look this up 🤖" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              toolCallId: "tool-1-0",
              toolName: "WEB_FETCH",
              input: { url: "https://example.com", note: loneInToolArgs },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "tool-1-0",
          toolName: "WEB_FETCH",
          content: loneInToolResult,
        },
      ],
    } as never);
    // Native params (messages/tools) return the structured result object.
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");

    expect(captured).toHaveLength(1);
    const body = assertStrictParseable(captured[0].bytes);
    const serialized = JSON.stringify(body);
    // Well-formed emoji from the user message survives untouched...
    expect(serialized).toContain("🤖");
    // ...while both injected lone surrogates were replaced.
    expect(serialized).toContain("fetched: emoji heavy �");
  });

  it("round-trips the exact captured failure signature safely", async () => {
    // The live 400: {"message":": Invalid JSON: lone leading surrogate in hex
    // escape...","code":"wrong_api_format"} — triggered by any \uD8xx escape.
    // Feed a raw lone leading surrogate straight through the handler and
    // assert the wire never carries the escape a strict parser rejects.
    await handleTextSmall(buildRuntime(), { prompt: "tail \uD83D" } as never);

    expect(captured).toHaveLength(1);
    const raw = captured[0].bytes.toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = assertStrictParseable(captured[0].bytes);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages.find((message) => message.role === "user")?.content).toBe("tail �");
  });

  // #18081: Tool descriptions, output schemas, and provider options must also
  // be sanitized — the original #18079 only sanitized prompt/messages/system.
  it("sanitizes a lone surrogate in a tool description (#18081)", async () => {
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "use the tool",
      tools: {
        "lone-surrogate-tool": {
          description: `bad tool \uD83D`,
          parameters: { type: "object", properties: {} },
        },
      },
    } as never);
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");

    expect(captured).toHaveLength(1);
    const raw = captured[0].bytes.toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = assertStrictParseable(captured[0].bytes);
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("bad tool \uFFFD");
    expect(LONE_SURROGATE_ESCAPE.test(serialized)).toBe(false);
  });

  it("sanitizes array tools before the real AI SDK schema getter is installed", async () => {
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "use the native tool",
      tools: [
        {
          name: "native-tool",
          description: `bad tool ${"\uD83D"}`,
          parameters: {
            type: "object",
            properties: {
              value: { type: "string", description: `bad schema ${"\uD83D"}` },
            },
          },
        },
      ],
    } as never);
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");

    expect(captured).toHaveLength(1);
    const body = assertStrictParseable(captured[0].bytes);
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("bad tool \uFFFD");
    expect(serialized).toContain("bad schema \uFFFD");
    expect(LONE_SURROGATE_ESCAPE.test(serialized)).toBe(false);
  });

  // #18081 review: structured-output schemas must also be sanitized. The plain
  // schema is sanitized before being wrapped in Output.object, so schema keys
  // AND values carrying lone surrogates never reach the provider wire.
  it("sanitizes a lone surrogate in a response schema key and description (#18081 review)", async () => {
    await handleTextSmall(buildRuntime(), {
      prompt: "return structured data",
      responseSchema: {
        type: "object",
        description: `schema desc \uD83D`,
        properties: {
          goodField: { type: "string", description: "clean" },
          [`bad${"\uD83D"}`]: { type: "string", description: `also \uD83D` },
        },
      },
    } as never);
    expect(captured).toHaveLength(1);
    const raw = captured[0].bytes.toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = assertStrictParseable(captured[0].bytes);
    const serialized = JSON.stringify(body);
    expect(LONE_SURROGATE_ESCAPE.test(serialized)).toBe(false);
  });
});
