/**
 * A provider 400 saying it could not parse a tool call out of the model's own
 * output (Cerebras's parser_error) is never re-sent by this plugin, whatever
 * its wording: the caller decides whether the call gets one more try. A 429,
 * and a 400 worded as a rate limit, are still re-sent as before. Drives the
 * real text handlers and AI SDK against a local provider.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleActionPlanner, handleResponseHandler } from "../models/text";

interface Reply {
  status: number;
  body?: unknown;
}

let server: Server | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

const LOGGED_MESSAGE =
  "Failed to generate tool_calls. Exception: Failed to generate tool call but tool_choice = 'required'.";
/** Cerebras's flat body for the failure, as the resident logged it. */
const parserError = (message: string, code: string | null = "parser_error") => ({
  message,
  type: "generation_error",
  param: "tool_calls",
  code,
  id: "",
  failed_generation: null,
});

const chunk = {
  id: "chatcmpl-parse",
  object: "chat.completion.chunk",
  created: 1,
  model: "qwen-3.8-27b",
};
const frame = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;

/** Answers request n with `replies[n - 1]`, repeating the last; a 200 answers "Recovered". */
async function provider(replies: Reply[]) {
  let requests = 0;
  server = createServer((request, response) => {
    let text = "";
    request.on("data", (part) => (text += part));
    request.on("end", () => {
      requests++;
      const reply = replies[Math.min(requests, replies.length) - 1] as Reply;
      if (reply.status !== 200) {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body ?? {}));
        return;
      }
      if (JSON.parse(text || "{}").stream === true) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          frame({
            ...chunk,
            choices: [{ index: 0, delta: { content: "Recovered" }, finish_reason: null }],
          }) +
            frame({
              ...chunk,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
            }) +
            "data: [DONE]\n\n"
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-parse",
          object: "chat.completion",
          created: 1,
          model: "qwen-3.8-27b",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Recovered" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  vi.stubEnv("OPENAI_API_KEY", "local-test-key");
  vi.stubEnv("OPENAI_BASE_URL", baseURL);
  vi.stubEnv("CEREBRAS_API_KEY", "");
  vi.stubEnv("ELIZA_PROVIDER", "cerebras");
  for (const slot of [
    "OPENAI_SMALL_MODEL",
    "OPENAI_LARGE_MODEL",
    "OPENAI_ACTION_PLANNER_MODEL",
    "OPENAI_RESPONSE_HANDLER_MODEL",
  ])
    vi.stubEnv(slot, "qwen-3.8-27b");
  const runtime = new AgentRuntime({
    character: {
      name: "ToolCallParseTest",
      settings: { OPENAI_API_KEY: "local-test-key", OPENAI_BASE_URL: baseURL },
    },
  });
  return { runtime, requests: () => requests };
}

/** One text call through the planner's live stream or Stage 1's generate lane. */
async function call(runtime: AgentRuntime, lane: "stream" | "generate") {
  const signal = AbortSignal.timeout(15_000);
  try {
    if (lane === "stream") {
      const result = await handleActionPlanner(runtime, {
        prompt: "Reply briefly.",
        stream: true,
        signal,
      } as never);
      let text = typeof result === "string" ? result : "";
      if (typeof result !== "string")
        for await (const part of (result as { textStream: AsyncIterable<string> }).textStream)
          text += part;
      return { text };
    }
    return {
      text: String(
        await handleResponseHandler(runtime, { prompt: "Reply briefly.", signal } as never)
      ),
    };
  } catch (error) {
    return { error: error as { statusCode?: number } };
  }
}

describe.each(["stream", "generate"] as const)("provider tool-call parse 400 (%s lane)", (lane) => {
  it.each([
    ["worded as Cerebras logs it", parserError(LOGGED_MESSAGE)],
    ["worded without 'required'", parserError("Failed to generate tool_calls.")],
    ["on tool_calls without the parser code", parserError("Failed to generate tool_calls.", null)],
    ["inside an OpenAI error envelope", { error: parserError("Failed to generate tool_calls.") }],
  ])(
    "makes one HTTP attempt on a parser failure %s",
    async (_name, body) => {
      const test = await provider([{ status: 400, body }, { status: 200 }]);
      const result = await call(test.runtime, lane);
      expect(result.error?.statusCode).toBe(400);
      expect(test.requests()).toBe(1);
    },
    30_000
  );

  it("does not re-send an unrelated 400 that only mentions generation", async () => {
    const test = await provider([
      { status: 400, body: { message: "Could not generate a response for this request" } },
      { status: 200 },
    ]);
    const result = await call(test.runtime, lane);
    expect(result.error?.statusCode).toBe(400);
    expect(test.requests()).toBe(1);
  }, 30_000);

  it("still re-sends a 429 and returns the answer", async () => {
    const test = await provider([
      {
        status: 429,
        body: { message: "Tokens per minute limit exceeded", type: "too_many_tokens_error" },
      },
      { status: 200 },
    ]);
    const result = await call(test.runtime, lane);
    expect(result.text).toBe("Recovered");
    expect(test.requests()).toBe(2);
  }, 30_000);

  it.each([
    ["in its message", { message: "Rate limit exceeded, slow down" }],
    [
      "in its envelope's type",
      {
        error: {
          message: "Too many tokens",
          type: "rate_limit_exceeded",
          code: "rate_limit_exceeded",
        },
      },
    ],
  ])(
    "still re-sends a 400 worded as a rate limit %s",
    async (_name, body) => {
      const test = await provider([{ status: 400, body }, { status: 200 }]);
      const result = await call(test.runtime, lane);
      expect(result.text).toBe("Recovered");
      expect(test.requests()).toBe(2);
    },
    30_000
  );
});
