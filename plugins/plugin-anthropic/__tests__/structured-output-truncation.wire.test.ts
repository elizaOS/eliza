/**
 * Wire-boundary regression, Anthropic path: the provider bills a structured
 * answer even when it does not parse. A native-output answer cut off at the
 * output budget must therefore still report MODEL_USED and reject as
 * MODEL_OUTPUT_INCOMPLETE, like the plain-text lane. Real `@ai-sdk/anthropic`
 * client against a loopback Messages API server.
 */
import { createServer, type Server } from "node:http";
import { AgentRuntime, EventType } from "@elizaos/core";
import { afterEach, expect, it } from "vitest";
import { handleTextSmall } from "../models/text";

const schema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};

let server: Server | undefined;
afterEach(async () => {
  const closing = server;
  server = undefined;
  if (!closing) return;
  closing.closeAllConnections();
  // The SDK may already have closed the listener; cleanup must not fail a test.
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

async function fixture(text: string, stopReason: "max_tokens" | "end_turn") {
  let requests = 0;
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "msg-test",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text }],
          stop_reason: stopReason,
          stop_sequence: null,
          usage: { input_tokens: 1200, output_tokens: 16 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback did not bind");
  const runtime = new AgentRuntime({
    character: { name: "StructuredTruncationWire", bio: [] },
    logLevel: "fatal",
    settings: {
      ANTHROPIC_API_KEY: "test-key",
      ANTHROPIC_AUTH_MODE: "apikey",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      ANTHROPIC_SMALL_MODEL: "claude-test",
    },
  });
  runtime.registerDatabaseAdapter({
    createLogs: async () => undefined,
  } as never);
  const usage: unknown[] = [];
  runtime.registerEvent(EventType.MODEL_USED, async (payload) => {
    usage.push((payload as { tokens?: unknown }).tokens);
  });
  const call = async () =>
    handleTextSmall(runtime, {
      prompt: "Return only the requested JSON object.",
      responseSchema: schema,
    } as never).then(
      () => undefined,
      (rejection: unknown) => rejection
    );
  return { call, usage, requests: () => requests };
}

it("reports and rejects a structured answer cut off at the output budget", async () => {
  const { call, usage, requests } = await fixture(
    '{"summary":"The user asked about the weath',
    "max_tokens"
  );

  const error = await call();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(requests()).toBe(1);
  expect(usage).toHaveLength(1);
  expect(error).toMatchObject({ code: "MODEL_OUTPUT_INCOMPLETE" });
});

it("keeps the parse error for a complete answer that does not parse", async () => {
  const { call, usage } = await fixture("not json at all", "end_turn");

  const error = await call();
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(usage).toHaveLength(1);
  expect((error as { code?: string }).code).not.toBe("MODEL_OUTPUT_INCOMPLETE");
});
