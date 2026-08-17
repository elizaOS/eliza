/** Verifies that the Discord service wrapper preserves Personal Shared timing. */

import { expect, mock, test } from "bun:test";

const personalSharedRequest = mock(
  async () =>
    new Response(
      JSON.stringify({
        success: true,
        data: {
          identity: { id: "11111111-1111-4111-8111-111111111111" },
          account: {
            userId: "22222222-2222-4222-8222-222222222222",
            organizationId: "33333333-3333-4333-8333-333333333333",
          },
          reply: "ready",
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Server-Timing":
            'account;dur=14.2;desc="sender-projection-hit", prewarm;dur=1.1, shared;dur=472.8',
        },
      },
    ),
);

mock.module("../../../eliza-app/personal-shared/messages/route", () => ({
  default: { request: personalSharedRequest },
}));

const { default: app } = await import("./route");
const executionCtx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

test("forwards the Personal Shared account, prewarm, and runtime split", async () => {
  const response = await app.request(
    "http://localhost/",
    {
      method: "POST",
      headers: {
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channelId: "444444444444444444",
        messageId: "555555555555555555",
        content: "hello",
        sender: { id: "666666666666666666", username: "tester" },
      }),
    },
    { INTERNAL_SECRET: "test-secret" } as never,
    executionCtx as never,
  );

  expect(response.status).toBe(200);
  expect(response.headers.get("Server-Timing")).toBe(
    'account;dur=14.2;desc="sender-projection-hit", prewarm;dur=1.1, shared;dur=472.8',
  );
  expect(personalSharedRequest).toHaveBeenCalledTimes(1);
});
