import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyLocalWebhookSignature } from "./_forward";

const AUTH_TOKEN = "test-twilio-auth-token";
const INTERNAL_URL = "http://10.0.0.7:8787/api/eliza-app/webhook/twilio";
const PUBLIC_URL = "https://app.eliza.cloud/api/eliza-app/webhook/twilio";

const BODY = new URLSearchParams({
  AccountSid: "AC11111111111111111111111111111111",
  Body: "hello from twilio",
  From: "+15550001111",
  MessageSid: "SM22222222222222222222222222222222",
  To: "+15550002222",
}).toString();

/** Twilio signs the public URL it was configured with, then param pairs. */
function twilioSignature(url: string, body: string, authToken: string): string {
  const sorted = Array.from(new URLSearchParams(body).entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}${value}`)
    .join("");
  return createHmac("sha1", authToken)
    .update(`${url}${sorted}`)
    .digest("base64");
}

function twilioRequest(headers: Record<string, string>): Request {
  return new Request(INTERNAL_URL, { method: "POST", headers, body: BODY });
}

describe("verifyLocalWebhookSignature twilio forwarded headers", () => {
  it("verifies against the first hop of a comma-joined proxy chain", async () => {
    const request = twilioRequest({
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": twilioSignature(PUBLIC_URL, BODY, AUTH_TOKEN),
      // Two hops: the edge prepends its own entry, so the header a worker sees
      // is the whole chain joined with ", ".
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "app.eliza.cloud, eliza-app-bff.internal",
    });

    expect(
      await verifyLocalWebhookSignature(request, "twilio", BODY, AUTH_TOKEN),
    ).toBe(true);
  });

  it("keeps verifying a single-hop forward", async () => {
    const request = twilioRequest({
      "x-twilio-signature": twilioSignature(PUBLIC_URL, BODY, AUTH_TOKEN),
      "x-forwarded-proto": "https",
      "x-forwarded-host": "app.eliza.cloud",
    });

    expect(
      await verifyLocalWebhookSignature(request, "twilio", BODY, AUTH_TOKEN),
    ).toBe(true);
  });

  it("rejects a signature built over the internal request URL", async () => {
    const request = twilioRequest({
      "x-twilio-signature": twilioSignature(INTERNAL_URL, BODY, AUTH_TOKEN),
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "app.eliza.cloud, eliza-app-bff.internal",
    });

    expect(
      await verifyLocalWebhookSignature(request, "twilio", BODY, AUTH_TOKEN),
    ).toBe(false);
  });
});
