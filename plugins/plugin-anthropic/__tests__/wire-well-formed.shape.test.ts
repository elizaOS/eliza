/**
 * Wire-boundary regression for #18025 on the Anthropic path: request bodies
 * built by the text handler must serialize to well-formed strict JSON even
 * when upstream text carries lone UTF-16 surrogates (a mid-emoji `.slice()`
 * leaves a lone leading surrogate that `JSON.stringify` emits as a bare
 * `\uD8xx` escape strict provider parsers reject). Real `@ai-sdk/anthropic`
 * client against a loopback Messages API server capturing raw request bytes.
 */
import { createServer, type Server } from "node:http";
import { type ElizaError, type IAgentRuntime, MAX_WELL_FORMED_VISITS } from "@elizaos/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleTextSmall } from "../models";

/** JSON.stringify only escapes surrogate code units when they are lone; a
 * well-formed body therefore contains no \ud800-\udfff escape at all. */
const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

const captured: Buffer[] = [];
let server: Server;
let baseUrl: string;

function startCaptureServer(): Promise<string> {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      captured.push(Buffer.from(raw, "utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      // When the request includes a structured output schema, the Anthropic
      // native output parser parses the response as JSON; return valid JSON.
      const hasStructuredOutput = /response_format|responseSchema|"schema"/.test(raw);
      const text = hasStructuredOutput ? JSON.stringify({ goodField: "value" }) : "ok";
      response.end(
        JSON.stringify({
          id: "msg-test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
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
  const settings: Record<string, string> = {
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_AUTH_MODE: "apikey",
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_SMALL_MODEL: "claude-test",
  };
  return {
    getSetting: vi.fn((key: string) => settings[key]),
    character: { name: "Ada" },
    emitEvent: vi.fn(),
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
  } as unknown as IAgentRuntime;
}

beforeAll(async () => {
  baseUrl = await startCaptureServer();
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  captured.length = 0;
  vi.stubEnv("ANTHROPIC_AUTH_MODE", "apikey");
  vi.stubEnv("ELIZA_TRAJECTORY_STRICT", undefined);
});

describe("#18025: Anthropic request bodies are well-formed strict JSON", () => {
  it("rejects an oversized sparse response schema before opening a provider request", async () => {
    const sparseSchema = new Array(MAX_WELL_FORMED_VISITS);

    await expect(
      handleTextSmall(buildRuntime(), {
        prompt: "hello",
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
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
    expect(LONE_SURROGATE_ESCAPE.test(body)).toBe(false);
    const parsed = JSON.parse(body) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(JSON.stringify(parsed.messages)).toContain("summarize this page �");
  });

  // #18081: Tool descriptions, stop sequences, output schemas, and provider
  // options must also be sanitized — the original #18079 only sanitized
  // prompt/messages/system, leaving these fields raw.
  it("sanitizes a lone surrogate in a stop sequence (#18081)", async () => {
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "hello",
      stopSequences: ["clean-stop", "bad\uD83D"],
    } as never);
    expect(result).toBe("ok");

    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
    const parsed = JSON.parse(body) as { stop_sequences?: string[] };
    expect(parsed.stop_sequences).toContain("clean-stop");
    // The lone surrogate in the stop sequence was replaced with U+FFFD.
    expect(parsed.stop_sequences).toContain("bad�");
  });

  it("sanitizes a lone surrogate in a tool description (#18081)", async () => {
    const result = await handleTextSmall(buildRuntime(), {
      prompt: "use the tool",
      tools: {
        lone_surrogate_tool: {
          name: "lone_surrogate_tool",
          description: `bad tool \uD83D`,
          parameters: { type: "object", properties: {} },
        },
      },
    } as never);
    expect(typeof result === "string" ? result : (result as { text: string }).text).toBe("ok");

    expect(captured).toHaveLength(1);
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
    const serialized = JSON.stringify(JSON.parse(body));
    expect(serialized).toContain("bad tool \uFFFD");
    expect(LONE_SURROGATE_ESCAPE.test(serialized)).toBe(false);
  });

  // #18081 review: structured-output schemas must also be sanitized. The plain
  // schema is sanitized before being wrapped in the native output shape, so
  // schema keys AND values carrying lone surrogates never reach the wire.
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
    const raw = captured[0].toString("utf8");
    expect(LONE_SURROGATE_ESCAPE.test(raw)).toBe(false);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(captured[0]);
    expect((body as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
  });
});
