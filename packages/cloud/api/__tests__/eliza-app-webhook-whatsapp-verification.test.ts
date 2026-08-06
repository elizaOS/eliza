/**
 * Meta's WhatsApp callback-URL verification handshake through the eliza-app
 * webhook forwarder.
 *
 * Meta verifies a callback URL with a `GET` carrying `hub.mode=subscribe`,
 * `hub.verify_token` and `hub.challenge`, and no signature header — there is no
 * body to sign. The forwarder used to run its HMAC check on that request, which
 * could only ever fail, so the URL could never be registered.
 *
 * These tests drive the real forwarder with a mocked upstream and assert both
 * halves of the contract: the handshake reaches the gateway, and every other
 * WhatsApp request still has to be signed.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

const { forwardToWebhookGateway } = (await import(
  "../eliza-app/webhook/_forward"
)) as typeof import("../eliza-app/webhook/_forward");

const GATEWAY = "https://gateway.internal.test";
const ENV = {
  ELIZA_APP_WEBHOOK_GATEWAY_URL: GATEWAY,
  ELIZA_APP_WHATSAPP_APP_SECRET: "whatsapp-app-secret",
  ENVIRONMENT: "production",
};

let upstreamUrl: string | null = null;
let upstreamCalls = 0;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  upstreamUrl = null;
  upstreamCalls = 0;
  globalThis.fetch = mock(async (input: unknown) => {
    upstreamCalls += 1;
    upstreamUrl = String(input);
    return new Response("CHALLENGE_ECHO", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function call(
  path: string,
  init: RequestInit = {},
  env: Record<string, unknown> = ENV,
): Promise<Response> {
  const app = new Hono();
  app.all("/api/eliza-app/webhook/whatsapp", (c) =>
    forwardToWebhookGateway(
      c as unknown as Parameters<typeof forwardToWebhookGateway>[0],
      "whatsapp",
    ),
  );
  return await app.request(
    `https://api.elizacloud.ai${path}`,
    { method: "GET", ...init },
    env,
  );
}

const VERIFY_QUERY =
  "?hub.mode=subscribe&hub.verify_token=the-verify-token&hub.challenge=CHALLENGE_ECHO";

describe("WhatsApp callback-URL verification handshake", () => {
  test("forwards Meta's verification GET to the gateway instead of rejecting it", async () => {
    const response = await call(
      `/api/eliza-app/webhook/whatsapp${VERIFY_QUERY}`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("CHALLENGE_ECHO");
    expect(upstreamCalls).toBe(1);
    // The gateway owns the verify-token comparison and echoes the challenge, so
    // the query string has to survive the hop intact.
    expect(upstreamUrl).toBe(
      `${GATEWAY}/webhook/eliza-app/whatsapp${VERIFY_QUERY}`,
    );
  });

  test("still requires a signature on a WhatsApp POST", async () => {
    const response = await call("/api/eliza-app/webhook/whatsapp", {
      method: "POST",
      body: JSON.stringify({ entry: [] }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "WEBHOOK_SIGNATURE_INVALID",
    });
    expect(upstreamCalls).toBe(0);
  });

  test("still requires a signature on a GET that is not the handshake", async () => {
    // A bare GET, or one missing hub.mode/hub.challenge, is not Meta's
    // handshake and gets no exemption.
    for (const query of [
      "",
      "?hub.mode=unsubscribe&hub.challenge=X",
      "?hub.mode=subscribe",
      "?hub.challenge=X",
    ]) {
      const response = await call(`/api/eliza-app/webhook/whatsapp${query}`);
      expect(response.status).toBe(401);
    }
    expect(upstreamCalls).toBe(0);
  });

  test("does not exempt a handshake-shaped GET on another platform", async () => {
    const app = new Hono();
    app.all("/api/eliza-app/webhook/twilio", (c) =>
      forwardToWebhookGateway(
        c as unknown as Parameters<typeof forwardToWebhookGateway>[0],
        "twilio",
      ),
    );

    const response = await app.request(
      `https://api.elizacloud.ai/api/eliza-app/webhook/twilio${VERIFY_QUERY}`,
      { method: "GET" },
      { ...ENV, ELIZA_APP_TWILIO_AUTH_TOKEN: "twilio-token" },
    );

    expect(response.status).toBe(401);
    expect(upstreamCalls).toBe(0);
  });
});
