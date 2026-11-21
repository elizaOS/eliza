/** Twilio webhook signature verification behind a proxy chain. */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { twilioAdapter } from "../src/adapters/twilio";
import type { WebhookConfig } from "../src/adapters/types";

const AUTH_TOKEN = "twilio_test_auth_token";
const RAW_BODY =
  "AccountSid=AC123&Body=hello&From=%2B15550001111&MessageSid=SM123&To=%2B15550002222";
const PUBLIC_URL = "https://gateway.eliza.cloud/webhooks/twilio/project/agent";
const INTERNAL_URL =
  "http://gateway.internal:3002/webhooks/twilio/project/agent";

function config(): WebhookConfig {
  return { authToken: AUTH_TOKEN } as WebhookConfig;
}

/** Twilio's scheme: base64(HMAC-SHA1(authToken, url + sorted(key+value))). */
function sign(url: string): string {
  const params = new URLSearchParams(RAW_BODY);
  const sorted = [...params.keys()]
    .sort()
    .map((key) => `${key}${params.get(key)}`)
    .join("");
  return createHmac("sha1", AUTH_TOKEN)
    .update(url + sorted)
    .digest("base64");
}

function webhookRequest(
  headers: Record<string, string>,
  url = INTERNAL_URL,
): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": sign(PUBLIC_URL),
      ...headers,
    },
    body: RAW_BODY,
  });
}

describe("twilio webhook signature behind a proxy", () => {
  test("accepts a single-hop forward", async () => {
    const request = webhookRequest({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "gateway.eliza.cloud",
    });
    expect(await twilioAdapter.verifyWebhook(request, RAW_BODY, config())).toBe(
      true,
    );
  });

  test("accepts a two-hop forward on one header line", async () => {
    const request = webhookRequest({
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "gateway.eliza.cloud",
    });
    expect(await twilioAdapter.verifyWebhook(request, RAW_BODY, config())).toBe(
      true,
    );
  });

  test("accepts two header lines that Node joins with a comma", async () => {
    const request = webhookRequest({
      "x-forwarded-proto": "https,http",
      "x-forwarded-host": "gateway.eliza.cloud, gateway.internal",
    });
    expect(await twilioAdapter.verifyWebhook(request, RAW_BODY, config())).toBe(
      true,
    );
  });

  test("accepts a scheme written with a trailing colon", async () => {
    const request = webhookRequest({
      "x-forwarded-proto": "https:",
      "x-forwarded-host": "gateway.eliza.cloud",
    });
    expect(await twilioAdapter.verifyWebhook(request, RAW_BODY, config())).toBe(
      true,
    );
  });

  test("keeps the request scheme when the forwarded scheme is empty", async () => {
    const request = webhookRequest(
      {
        "x-forwarded-proto": "",
        "x-forwarded-host": "gateway.eliza.cloud",
      },
      "https://gateway.internal:3002/webhooks/twilio/project/agent",
    );
    expect(await twilioAdapter.verifyWebhook(request, RAW_BODY, config())).toBe(
      true,
    );
  });

  test("rejects a signature made for another URL", async () => {
    const request = webhookRequest({
      "x-forwarded-proto": "https",
      "x-forwarded-host": "gateway.eliza.cloud",
    });
    const forged = new Request(request, {
      headers: {
        "x-twilio-signature": sign(
          "https://evil.example/webhooks/twilio/project/agent",
        ),
      },
    });
    expect(await twilioAdapter.verifyWebhook(forged, RAW_BODY, config())).toBe(
      false,
    );
  });
});
