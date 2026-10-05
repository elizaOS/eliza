/** Exercises the app inference SDK against a controlled HTTP server, including raw SSE and request retry identity. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Server } from "bun";
import { ElizaCloudClient } from "./client.js";

let server: Server<undefined>;
const appId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const clientId = crypto.randomUUID();
const received: Request[] = [];
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      received.push(request.clone());
      if (request.headers.get("Idempotency-Key") === "operation:already")
        return Response.json(
          {
            success: false,
            code: "APP_INFERENCE_OUTCOME_UNKNOWN",
            error: "Pending reconciliation",
          },
          { status: 409 },
        );
      const body = (await request.json()) as { stream?: boolean };
      if (body.stream)
        return new Response(
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      return Response.json({
        id: "chat_fixture",
        object: "chat.completion",
        created: 1,
        model: "fixture-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
});
afterAll(() => server.stop(true));
function client() {
  return new ElizaCloudClient({
    apiBaseUrl: server.url.href,
    apiKey: "unused_personal_key",
  }).appInference(appId, {
    clientId,
    clientSecret: "controlled-client-secret",
    developerApiKey: "eliza_controlled-developer-key",
  });
}
const operation = {
  billingAccountId: accountId,
  productFamilyKey: "main",
  delegationToken: "ead_controlled-grant",
  operationId: "operation:original",
};
test("request carries all independent authorities and complete model messages without legacy app credit headers", async () => {
  const content = "Full model context ".repeat(4000);
  const response = await client().createChatCompletion(operation, {
    model: "fixture-model",
    messages: [{ role: "user", content }],
  });
  expect(response.choices?.[0]?.message?.content).toBe("hello");
  const request = received.at(-1);
  if (!request) throw new Error("HTTP request not received");
  expect(new URL(request.url).pathname).toBe(
    `/api/v1/apps/${appId}/inference/chat/completions`,
  );
  expect(request.headers.get("Authorization")).toBe(
    `Basic ${btoa(`${clientId}:controlled-client-secret`)}`,
  );
  expect(request.headers.get("X-Eliza-Developer-Authorization")).toBe(
    "Bearer eliza_controlled-developer-key",
  );
  expect(request.headers.get("X-App-Delegation")).toBe(
    operation.delegationToken,
  );
  expect(request.headers.get("X-Eliza-Billing-Account-Id")).toBe(accountId);
  expect(request.headers.get("Idempotency-Key")).toBe(operation.operationId);
  expect(request.headers.has("X-App-Id")).toBe(false);
  expect(request.headers.has("X-API-Key")).toBe(false);
  expect(await request.json()).toMatchObject({
    messages: [{ role: "user", content }],
  });
});
test("streaming returns complete SSE bytes and a pending operation is an explicit error", async () => {
  const response = await client().streamChatCompletion(
    { ...operation, operationId: "operation:stream" },
    { model: "fixture-model", messages: [{ role: "user", content: "hello" }] },
  );
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(await response.text()).toBe(
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
  );
  const before = received.length;
  await expect(
    client().createChatCompletion(
      { ...operation, operationId: "operation:already" },
      {
        model: "fixture-model",
        messages: [{ role: "user", content: "hello" }],
      },
    ),
  ).rejects.toMatchObject({
    statusCode: 409,
    errorBody: { code: "APP_INFERENCE_OUTCOME_UNKNOWN" },
  });
  expect(received.length - before).toBe(1);
});
