/**
 * Path-traversal and signature guards for the eliza-app webhook forwarder
 * (finding L3/L4, #12878).
 *
 * `_forward.ts` appends the request's trailing path onto the internal gateway
 * URL. These tests pin that only empty/benign safe-char suffixes survive, and
 * that any dot-segment or percent-encoded separator (which the URL parser leaves
 * intact) is rejected before it can escape `/webhook/<project>/<platform>`.
 */

import { describe, expect, mock, test } from "bun:test";

// Mock the logger before importing so loading the forwarder never pulls the
// real logger chain (core → @elizaos/cloud-routing).
mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

const { safeWebhookSuffix, verifyLocalWebhookSignature } = (await import(
  "../eliza-app/webhook/_forward"
)) as typeof import("../eliza-app/webhook/_forward");

const P = "telegram";
const base = `/api/eliza-app/webhook/${P}`;

describe("safeWebhookSuffix", () => {
  test("an exact-match path has an empty suffix", () => {
    expect(safeWebhookSuffix(base, P)).toBe("");
  });

  test("a bare trailing slash is normalized to empty", () => {
    expect(safeWebhookSuffix(`${base}/`, P)).toBe("");
  });

  test("a benign safe-char sub-path is preserved", () => {
    expect(safeWebhookSuffix(`${base}/inbound/v2`, P)).toBe("/inbound/v2");
  });

  test("a non-matching prefix yields empty (nothing to forward)", () => {
    expect(safeWebhookSuffix("/api/other/telegram", P)).toBe("");
  });

  test.each([
    `${base}/..`,
    `${base}/../admin`,
    `${base}/..%2fadmin`,
    `${base}/%2e%2e%2fadmin`,
    `${base}/foo%2f..%2fbar`,
    `${base}/foo/../bar`,
    `${base}/foo\\bar`,
    `${base}/foo.bar`,
    `${base}/foo%00`,
  ])("rejects a traversal/encoded suffix: %s", (pathname) => {
    expect(safeWebhookSuffix(pathname, P)).toBeNull();
  });
});

async function hmacHex(
  secret: string,
  payload: string,
  algorithm = "SHA-256",
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: algorithm },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacBase64(
  secret: string,
  payload: string,
  algorithm = "SHA-1",
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: algorithm },
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

describe("verifyLocalWebhookSignature", () => {
  test("accepts and rejects Telegram secret-token headers", async () => {
    const request = new Request(
      "https://api.example.test/api/eliza-app/webhook/telegram",
      {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "telegram-secret" },
        body: "{}",
      },
    );

    await expect(
      verifyLocalWebhookSignature(request, "telegram", "", "telegram-secret"),
    ).resolves.toBe(true);
    await expect(
      verifyLocalWebhookSignature(request, "telegram", "", "wrong-secret"),
    ).resolves.toBe(false);
  });

  test("accepts and rejects Blooio timestamped HMAC signatures", async () => {
    const body = JSON.stringify({
      event: "message.received",
      message_id: "m1",
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await hmacHex("blooio-secret", `${timestamp}.${body}`);
    const request = new Request(
      "https://api.example.test/api/eliza-app/webhook/blooio",
      {
        method: "POST",
        headers: { "x-blooio-signature": `t=${timestamp},v1=${signature}` },
        body,
      },
    );

    await expect(
      verifyLocalWebhookSignature(request, "blooio", body, "blooio-secret"),
    ).resolves.toBe(true);
    await expect(
      verifyLocalWebhookSignature(request, "blooio", body, "wrong-secret"),
    ).resolves.toBe(false);
  });

  test("accepts Blooio retries inside the documented five-minute window", async () => {
    const body = JSON.stringify({
      type: "message.sent",
      id: "evt_1",
      created_at: Date.now(),
      data: { id: "m1" },
    });
    const timestamp = Math.floor(Date.now() / 1000) - 200;
    const signature = await hmacHex("blooio-secret", `${timestamp}.${body}`);
    const request = new Request(
      "https://api.example.test/api/eliza-app/webhook/blooio",
      {
        method: "POST",
        headers: { "x-blooio-signature": `t=${timestamp},v1=${signature}` },
        body,
      },
    );

    await expect(
      verifyLocalWebhookSignature(request, "blooio", body, "blooio-secret"),
    ).resolves.toBe(true);
  });

  test("accepts and rejects Twilio signatures over URL plus sorted form params", async () => {
    const body = new URLSearchParams({
      From: "+15551234567",
      MessageSid: "SM_test",
      To: "+15550000000",
    }).toString();
    const url = "https://api.example.test/api/eliza-app/webhook/twilio";
    const signedPayload = `${url}From+15551234567MessageSidSM_testTo+15550000000`;
    const signature = await hmacBase64("twilio-secret", signedPayload);
    const request = new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body,
    });

    await expect(
      verifyLocalWebhookSignature(request, "twilio", body, "twilio-secret"),
    ).resolves.toBe(true);
    await expect(
      verifyLocalWebhookSignature(request, "twilio", body, "wrong-secret"),
    ).resolves.toBe(false);
  });
});
