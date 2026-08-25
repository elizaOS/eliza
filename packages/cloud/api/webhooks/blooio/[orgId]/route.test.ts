/**
 * Proves the real Blooio route has one signed provider authority and preserves
 * its payload-validation and idempotency contracts under deterministic fixtures.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";

const webhookSecret = "test-blooio-webhook-secret";
const organizationId = "11111111-1111-4111-8111-111111111111";
const processedKeys = new Set<string>();
const isAlreadyProcessed = mock(async (key: string) => processedKeys.has(key));
const markAsProcessed = mock(async (key: string) => {
  processedKeys.add(key);
});

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

mock.module("@/lib/utils/idempotency", () => ({
  isAlreadyProcessed,
  markAsProcessed,
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

function request(
  body: string,
  options: {
    path?: string;
    query?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  const path = options.path ?? "";
  const query = options.query ? `?${options.query}` : "";
  return new Request(
    `https://api.example.test/${organizationId}${path}${query}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...options.headers,
      },
      body,
    },
  );
}

function fetchRoute(requestValue: Request): Promise<Response> {
  return Promise.resolve(
    mountedApp.fetch(requestValue, { NODE_ENV: "production" }),
  );
}

const retiredBridgePayload = {
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

describe("Blooio webhook authority", () => {
  beforeEach(() => {
    processedKeys.clear();
    isAlreadyProcessed.mockClear();
    markAsProcessed.mockClear();
  });

  test("contains no deleted bridge import, discriminator, or child route", async () => {
    const source = await Bun.file(
      new URL("./route.ts", import.meta.url),
    ).text();

    expect(source).not.toContain("../../bluebubbles/route");
    expect(source).not.toContain('header("x-eliza-bridge")');
    expect(source).not.toContain('query("bridge")');
    expect(source).not.toContain('app.post("/bluebubbles"');
  });

  test("does not let bridge query or header metadata bypass Blooio signing", async () => {
    const body = JSON.stringify(retiredBridgePayload);
    const requests = [
      request(body, { query: "bridge=bluebubbles" }),
      request(body, { headers: { "x-eliza-bridge": "bluebubbles" } }),
    ];

    for (const requestValue of requests) {
      const response = await fetchRoute(requestValue);
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid webhook signature",
      });
    }

    expect(isAlreadyProcessed).not.toHaveBeenCalled();
    expect(markAsProcessed).not.toHaveBeenCalled();
  });

  test("does not expose a retired bridge child route", async () => {
    const body = JSON.stringify(retiredBridgePayload);
    const response = await fetchRoute(
      request(body, {
        path: "/bluebubbles",
        headers: { "x-blooio-signature": signature(body) },
      }),
    );

    expect(response.status).toBe(404);
    expect(isAlreadyProcessed).not.toHaveBeenCalled();
    expect(markAsProcessed).not.toHaveBeenCalled();
  });

  test("validates a signed non-Blooio envelope as provider input", async () => {
    const body = JSON.stringify(retiredBridgePayload);
    const response = await fetchRoute(
      request(body, {
        query: "bridge=bluebubbles",
        headers: { "x-blooio-signature": signature(body) },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid webhook payload",
    });
    expect(isAlreadyProcessed).not.toHaveBeenCalled();
    expect(markAsProcessed).not.toHaveBeenCalled();
  });

  test("accepts a signed Blooio v4 event and deduplicates its retry", async () => {
    const body = JSON.stringify({
      id: "evt_blooio_v4",
      type: "message.sent",
      created_at: 1_786_291_200_000,
      data: {
        id: "msg_blooio_v4",
        sender: "+15555550123",
        recipient: "+18087881821",
        text: "hello",
      },
    });
    const headers = { "x-blooio-signature": signature(body) };

    const firstResponse = await fetchRoute(request(body, { headers }));
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toEqual({ success: true });
    expect(isAlreadyProcessed).toHaveBeenCalledWith("blooio:msg_blooio_v4");
    expect(markAsProcessed).toHaveBeenCalledWith(
      "blooio:msg_blooio_v4",
      "blooio",
    );

    const retryResponse = await fetchRoute(request(body, { headers }));
    expect(retryResponse.status).toBe(200);
    await expect(retryResponse.json()).resolves.toEqual({
      success: true,
      status: "already_processed",
    });
    expect(isAlreadyProcessed).toHaveBeenCalledTimes(2);
    expect(markAsProcessed).toHaveBeenCalledTimes(1);
  });

  test("rejects a signed inbound message without a stable ID", async () => {
    const body = JSON.stringify({
      event: "message.received",
      sender: "+15555550123",
      text: "hello",
    });
    const response = await fetchRoute(
      request(body, {
        headers: { "x-blooio-signature": signature(body) },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Inbound message ID is required",
    });
    expect(isAlreadyProcessed).not.toHaveBeenCalled();
    expect(markAsProcessed).not.toHaveBeenCalled();
  });
});
