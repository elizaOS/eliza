import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyWhatsAppWebhookSignature,
} from "../src/webhook-auth.js";

describe("verifyWhatsAppWebhookSignature", () => {
  const appSecret = "test-app-secret";
  const payload = JSON.stringify({
    entry: [{ changes: [{ value: { messages: [] } }] }],
  });

  function sign(body: string): string {
    const digest = crypto
      .createHmac("sha256", appSecret)
      .update(body)
      .digest("hex");
    return `sha256=${digest}`;
  }

  it("accepts a valid X-Hub-Signature-256", () => {
    expect(
      verifyWhatsAppWebhookSignature(appSecret, sign(payload), payload),
    ).toBe(true);
  });

  it("rejects a missing signature header", () => {
    expect(verifyWhatsAppWebhookSignature(appSecret, undefined, payload)).toBe(
      false,
    );
  });

  it("rejects a bad signature", () => {
    expect(
      verifyWhatsAppWebhookSignature(appSecret, "sha256=deadbeef", payload),
    ).toBe(false);
  });

  it("rejects when the signed body bytes differ", () => {
    expect(
      verifyWhatsAppWebhookSignature(
        appSecret,
        sign(payload),
        `${payload} `,
      ),
    ).toBe(false);
  });

  it("rejects when app secret is not configured", () => {
    expect(verifyWhatsAppWebhookSignature("", sign(payload), payload)).toBe(
      false,
    );
  });
});
