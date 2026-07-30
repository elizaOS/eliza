/**
 * Verifies the Responses compatibility route delegates authentication, rate
 * limiting, admission, and provider dispatch to the cache-only chat handler.
 */

import { afterAll, expect, mock, test } from "bun:test";

const requireUserOrApiKeyWithOrg = mock(async () => {
  throw new Error("authoritative-auth-tripwire");
});
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

const handleChatCompletionsPOST = mock(
  async (
    _request: Request,
    _options: {
      skipOrgRateLimit?: boolean;
      executionCtx?: { waitUntil(promise: Promise<unknown>): void };
      traceId?: string;
    },
  ) =>
    Response.json({
      id: "chat-response",
      model: "provider/model",
      choices: [{ message: { content: "ready" } }],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1,
        total_tokens: 3,
      },
    }),
);
mock.module("../v1/chat/completions/route", () => ({
  handleChatCompletionsPOST,
}));

const { default: responsesApp } = await import("../v1/responses/route");

afterAll(() => {
  mock.restore();
});

test("Worker Responses requests use the chat cache-only admission path", async () => {
  const background: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil(promise: Promise<unknown>) {
      background.push(promise);
    },
    passThroughOnException() {},
    props: {},
  };
  const response = await responsesApp.fetch(
    new Request("https://cloud.test/", {
      method: "POST",
      headers: {
        Authorization: "Bearer eliza_test_key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "provider/model",
        input: "hello",
      }),
    }),
    {},
    executionCtx,
  );

  expect(response.status).toBe(200);
  expect(requireUserOrApiKeyWithOrg).not.toHaveBeenCalled();
  expect(handleChatCompletionsPOST).toHaveBeenCalledTimes(1);
  expect(handleChatCompletionsPOST.mock.calls[0]?.[1]).toMatchObject({
    executionCtx,
  });
  expect(
    handleChatCompletionsPOST.mock.calls[0]?.[1]?.skipOrgRateLimit,
  ).not.toBe(true);
});
