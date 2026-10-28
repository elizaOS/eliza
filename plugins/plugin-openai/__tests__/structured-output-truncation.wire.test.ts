/** Real SQLite runtime, core useModel and AI SDK over loopback HTTP.
 * The provider bills a structured answer even when it does not parse, so the
 * usage must still be reported, and an answer cut off at the output budget
 * must fail as MODEL_OUTPUT_INCOMPLETE like a cut-off plain-text answer.
 */

import { createServer, type Server } from "node:http";
import { EventType, ModelType } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
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
  await new Promise<void>((resolve, reject) =>
    closing.close((error) => (error ? reject(error) : resolve()))
  );
});

async function fixture(content: string, finishReason: "length" | "stop") {
  let requests = 0;
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      requests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "fixture",
          object: "chat.completion",
          created: 1,
          model: "gpt-5.6-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: finishReason,
            },
          ],
          usage: { prompt_tokens: 1200, completion_tokens: 16, total_tokens: 1216 },
        })
      );
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback did not bind");
  const runtime = createSQLiteTestRuntime({
    character: { name: "StructuredTruncationWire", bio: ["Isolated integration fixture"] },
    settings: {
      ELIZA_PROVIDER: "openai",
      OPENAI_API_KEY: "loopback-fixture-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      OPENAI_SMALL_MODEL: "gpt-5.6-mini",
      CEREBRAS_API_KEY: "",
      OPENROUTER_API_KEY: "",
      OPENROUTER_FALLBACK_MODEL: "",
    },
    logLevel: "fatal",
  });
  runtime.registerModel(
    ModelType.TEXT_SMALL,
    (owner, params) => handleTextSmall(owner, { ...params, stream: false }),
    "openai",
    100
  );
  const usage: unknown[] = [];
  runtime.registerEvent(EventType.MODEL_USED, async (payload) => {
    usage.push((payload as { tokens?: unknown }).tokens);
  });
  const call = async (extra: Record<string, unknown>) => {
    const error = await runtime
      .useModel(ModelType.TEXT_SMALL, {
        system: "Return only the requested JSON object.",
        messages: [{ role: "user", content: "Summarize the turn." }],
        temperature: 0,
        ...extra,
      } as never)
      .then(
        () => undefined,
        (rejection: unknown) => rejection
      );
    // MODEL_USED is emitted without awaiting its listeners.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return error;
  };
  return { call, usage, requests: () => requests };
}

it.each([
  [
    "the evaluator's schema request",
    { responseSchema: schema, responseFormat: { type: "json_object" } },
  ],
  ["a JSON-object request", { responseFormat: { type: "json_object" } }],
])("reports and rejects %s cut off at the output budget", async (_label, extra) => {
  const { call, usage, requests } = await fixture(
    '{"summary":"The user asked about the weath',
    "length"
  );

  const error = await call(extra);

  expect(requests()).toBe(1);
  expect(error).toMatchObject({
    code: "MODEL_OUTPUT_INCOMPLETE",
    context: {
      provider: "openai",
      model: "gpt-5.6-mini",
      finishReason: "length",
      maxTokens: null,
      usage: { promptTokens: 1200, completionTokens: 16, totalTokens: 1216 },
    },
  });
  expect(usage).toEqual([expect.objectContaining({ prompt: 1200, completion: 16, total: 1216 })]);
});

it("reports a billed JSON-object answer that does not parse and keeps its error", async () => {
  const { call, usage, requests } = await fixture("Sure! Here is the summary.", "stop");

  const error = await call({ responseFormat: { type: "json_object" } });

  expect(requests()).toBe(1);
  expect(error).toMatchObject({ name: "AI_NoObjectGeneratedError", finishReason: "stop" });
  expect(error).not.toHaveProperty("code", "MODEL_OUTPUT_INCOMPLETE");
  expect(usage).toEqual([expect.objectContaining({ prompt: 1200, completion: 16, total: 1216 })]);
});
