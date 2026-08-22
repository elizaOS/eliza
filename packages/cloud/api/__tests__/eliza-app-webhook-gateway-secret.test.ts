/**
 * Gateway shared-secret stamping for the eliza-app webhook forwarder
 * (finding L3, #12878 / #12227).
 *
 * The webhook forwarders are unauthenticated at the edge (a provider can't
 * present a Cloud session), so the internal gateway needs a local signal that a
 * request actually transited THIS BFF. The forwarder now:
 *   - strips any inbound `x-eliza-webhook-forwarder-secret` the caller tried to
 *     spoof (on EVERY proxied request), and
 *   - re-stamps its own value from the DEDICATED
 *     `ELIZA_APP_WEBHOOK_GATEWAY_SECRET` ONLY on gateway forwards (never on the
 *     Discord handler path, which may be a separate/public service).
 *
 * These tests capture the outbound headers by mocking global `fetch` and assert
 * the strip/stamp contract for each case, including Twilio re-signing after
 * the BFF rewrites the upstream route.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

const { forwardToWebhookGateway, forwardToDiscordWebhookHandler } =
  (await import(
    "../eliza-app/webhook/_forward"
  )) as typeof import("../eliza-app/webhook/_forward");

const HEADER = "x-eliza-webhook-forwarder-secret";
const GATEWAY = "https://gateway.internal.test";

let capturedHeaders: Headers | null = null;
let capturedUrl: string | null = null;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  capturedHeaders = null;
  capturedUrl = null;
  globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
    // The forwarder builds a Request/URL + Headers; capture what it sends.
    capturedUrl = String(input);
    capturedHeaders = new Headers(init?.headers as HeadersInit);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function forward(
  env: Record<string, unknown>,
  inboundSecretHeader?: string,
): Promise<Response> {
  const app = new Hono();
  app.all("/api/eliza-app/webhook/telegram", async (c) => {
    return await forwardToWebhookGateway(
      c as unknown as Parameters<typeof forwardToWebhookGateway>[0],
      "telegram",
    );
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (inboundSecretHeader !== undefined) {
    headers[HEADER] = inboundSecretHeader;
  }
  return Promise.resolve(
    app.fetch(
      new Request("https://api.example.test/api/eliza-app/webhook/telegram", {
        method: "POST",
        headers,
        body: "{}",
      }),
      env,
    ),
  );
}

describe("forwardToWebhookGateway — gateway shared secret (L3)", () => {
  test("stamps the configured secret on the forwarded request", async () => {
    const res = await forward({
      ELIZA_APP_WEBHOOK_GATEWAY_URL: GATEWAY,
      ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "s3cr3t",
    });
    expect(res.status).toBe(200);
    expect(capturedHeaders?.get(HEADER)).toBe("s3cr3t");
  });

  test("does NOT reuse GATEWAY_INTERNAL_SECRET (decoupled from internal-event)", async () => {
    // Only the internal-event secret is set; the forwarder secret is not. The
    // header must NOT be stamped — the two secrets are independent.
    const res = await forward({
      ELIZA_APP_WEBHOOK_GATEWAY_URL: GATEWAY,
      GATEWAY_INTERNAL_SECRET: "internal-only",
    });
    expect(res.status).toBe(200);
    expect(capturedHeaders?.get(HEADER)).toBeNull();
  });

  test("strips a caller-supplied secret header when none is configured", async () => {
    // A client tries to forge the trust header; with no secret configured we
    // must NOT pass it through to the gateway.
    const res = await forward(
      { ELIZA_APP_WEBHOOK_GATEWAY_URL: GATEWAY },
      "attacker-injected",
    );
    expect(res.status).toBe(200);
    expect(capturedHeaders?.get(HEADER)).toBeNull();
  });

  test("overrides a caller-supplied secret header with the configured value", async () => {
    const res = await forward(
      {
        ELIZA_APP_WEBHOOK_GATEWAY_URL: GATEWAY,
        ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "real-secret",
      },
      "attacker-injected",
    );
    expect(res.status).toBe(200);
    // The attacker value is replaced by the trusted one, never concatenated.
    expect(capturedHeaders?.get(HEADER)).toBe("real-secret");
  });

  test("re-signs Twilio form data for the rewritten gateway route", async () => {
    const secret = "twilio-secret";
    const body = new URLSearchParams({
      MessageSid: "SM_sms_inbound",
      AccountSid: "AC_test",
      From: "+15551234567",
      To: "+14155238886",
      Body: "hello from SMS",
    }).toString();
    const publicUrl = "https://api.example.test/api/eliza-app/webhook/twilio";
    const sorted = Array.from(new URLSearchParams(body).entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}${value}`)
      .join("");
    const inboundSignature = await hmacBase64(secret, `${publicUrl}${sorted}`);

    const app = new Hono();
    app.post("/api/eliza-app/webhook/twilio", async (c) =>
      forwardToWebhookGateway(
        c as unknown as Parameters<typeof forwardToWebhookGateway>[0],
        "twilio",
      ),
    );
    const response = await app.fetch(
      new Request(publicUrl, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "x-twilio-signature": inboundSignature,
        },
        body,
      }),
      {
        ELIZA_APP_WEBHOOK_GATEWAY_URL: GATEWAY,
        ELIZA_APP_TWILIO_AUTH_TOKEN: secret,
      },
    );

    expect(response.status).toBe(200);
    expect(capturedUrl).toBe(
      "https://gateway.internal.test/webhook/eliza-app/twilio",
    );
    const forwardedPublicUrl =
      "https://api.example.test/webhook/eliza-app/twilio";
    const expectedForwardedSignature = await hmacBase64(
      secret,
      `${forwardedPublicUrl}${sorted}`,
    );
    expect(capturedHeaders?.get("x-twilio-signature")).toBe(
      expectedForwardedSignature,
    );
    expect(expectedForwardedSignature).not.toBe(inboundSignature);
  });
});

async function hmacBase64(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

function forwardDiscord(
  env: Record<string, unknown>,
  inboundSecretHeader?: string,
): Promise<Response> {
  const app = new Hono();
  app.all("/api/eliza-app/webhook/discord", async (c) => {
    return await forwardToDiscordWebhookHandler(
      c as unknown as Parameters<typeof forwardToDiscordWebhookHandler>[0],
    );
  });
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (inboundSecretHeader !== undefined) {
    headers[HEADER] = inboundSecretHeader;
  }
  return Promise.resolve(
    app.fetch(
      new Request("https://api.example.test/api/eliza-app/webhook/discord", {
        method: "POST",
        headers,
        body: "{}",
      }),
      env,
    ),
  );
}

describe("forwardToDiscordWebhookHandler — never leaks the forwarder secret (L3)", () => {
  test("does NOT stamp the secret onto the Discord handler even when configured", async () => {
    const res = await forwardDiscord({
      ELIZA_APP_DISCORD_WEBHOOK_HANDLER_URL: "https://discord-handler.test",
      // Secret is set, but Discord is a separate/public service — must NOT leak.
      ELIZA_APP_WEBHOOK_GATEWAY_SECRET: "gateway-only-secret",
    });
    expect(res.status).toBe(200);
    expect(capturedHeaders?.get(HEADER)).toBeNull();
  });

  test("still strips a caller-supplied secret header on the Discord path", async () => {
    const res = await forwardDiscord(
      { ELIZA_APP_DISCORD_WEBHOOK_HANDLER_URL: "https://discord-handler.test" },
      "attacker-injected",
    );
    expect(res.status).toBe(200);
    expect(capturedHeaders?.get(HEADER)).toBeNull();
  });
});
