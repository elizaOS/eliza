// Exercises cloud API webhooks blooio orgid route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";

const handleBlueBubblesWebhook = mock(async () =>
  Response.json({ success: true, source: "bluebubbles-direct" }),
);
const handleBlueBubblesWebhookPayload = mock(async (_c, payload: unknown) =>
  Response.json({ success: true, source: "bluebubbles-payload", payload }),
);

mock.module("../../bluebubbles/route", () => ({
  handleBlueBubblesWebhook,
  handleBlueBubblesWebhookPayload,
}));

mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
  RateLimitPresets: {
    AGGRESSIVE: {},
  },
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

const { default: app } = await import("./route");

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://api.example.test/?bridge=bluebubbles", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const blueBubblesPayload = {
  type: "new-message",
  data: {
    guid: "message-1",
    text: "hello",
    isFromMe: false,
    handle: {
      address: "+15555550123",
    },
  },
};

describe("Blooio webhook BlueBubbles compatibility", () => {
  beforeEach(() => {
    handleBlueBubblesWebhook.mockClear();
    handleBlueBubblesWebhookPayload.mockClear();
  });

  test("dispatches explicit bridge requests before Blooio signature validation", async () => {
    const response = await app.fetch(post(blueBubblesPayload));

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      source: "bluebubbles-direct",
    });
    expect(handleBlueBubblesWebhook).toHaveBeenCalledTimes(1);
    expect(handleBlueBubblesWebhookPayload).not.toHaveBeenCalled();
  });

  test("detects BlueBubbles-shaped payloads even without the bridge query", async () => {
    const response = await app.fetch(
      new Request("https://api.example.test/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(blueBubblesPayload),
      }),
    );

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      source: "bluebubbles-payload",
      payload: blueBubblesPayload,
    });
    expect(handleBlueBubblesWebhook).not.toHaveBeenCalled();
    expect(handleBlueBubblesWebhookPayload).toHaveBeenCalledTimes(1);
  });
});
