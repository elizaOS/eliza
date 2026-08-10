// Exercises cloud API webhooks blooio orgid route.test behavior with deterministic Worker route fixtures.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";

const webhookSecret = "test-blooio-webhook-secret";

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

mock.module("@/lib/services/blooio-automation", () => ({
  blooioAutomationService: {
    getWebhookSecret: mock(async () => webhookSecret),
  },
}));

const { default: app } = await import("./route");
const mountedApp = new Hono().route("/:orgId", app);

function signature(body: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", webhookSecret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

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

  test("does not misroute a Blooio v4 envelope as BlueBubbles", async () => {
    const response = await mountedApp.fetch(
      new Request("https://api.example.test/test-org", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-blooio-signature": "t=0,v1=invalid",
        },
        body: JSON.stringify({
          id: "evt_blooio_v4",
          type: "message.received",
          created_at: 1_786_291_200_000,
          data: {
            id: "msg_blooio_v4",
            sender: "+15555550123",
            recipient: "+18087881821",
            text: "hello",
          },
        }),
      }),
      { NODE_ENV: "production" },
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid webhook signature",
    });
    expect(handleBlueBubblesWebhook).not.toHaveBeenCalled();
    expect(handleBlueBubblesWebhookPayload).not.toHaveBeenCalled();
  });

  test("rejects an inbound message without a stable ID", async () => {
    const body = JSON.stringify({
      event: "message.received",
      sender: "+15555550123",
      text: "hello",
    });
    const response = await mountedApp.fetch(
      new Request("https://api.example.test/test-org", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-blooio-signature": signature(body),
        },
        body,
      }),
      { NODE_ENV: "production" },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Inbound message ID is required",
    });
    expect(handleBlueBubblesWebhook).not.toHaveBeenCalled();
    expect(handleBlueBubblesWebhookPayload).not.toHaveBeenCalled();
  });
});
