// Exercises whatsapp api behavior with deterministic cloud-shared lib fixtures.
import crypto from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { logger } from "./logger";

import {
  e164ToWhatsappId,
  isValidWhatsAppId,
  sendWhatsAppTypingIndicator,
  verifyWhatsAppSignature,
  whatsappIdToE164,
} from "./whatsapp-api";

/**
 * WhatsApp webhook auth + identity helpers. verifyWhatsAppSignature is the
 * gate that proves a webhook really came from Meta (HMAC-SHA256 over the raw
 * body, constant-time compared) — a forged or tampered body must be rejected.
 * The id<->E.164 conversions key the sender to a stable contact identity.
 */

const SECRET = "app-secret-123";
const BODY = '{"entry":[{"id":"1"}]}';

function sign(body: string, secret = SECRET): string {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

describe("verifyWhatsAppSignature", () => {
  test("accepts a genuine Meta signature", () => {
    expect(verifyWhatsAppSignature(SECRET, sign(BODY), BODY)).toBe(true);
  });

  test("rejects tampered body, wrong secret, and malformed headers", () => {
    expect(verifyWhatsAppSignature(SECRET, sign(BODY), `${BODY} tampered`)).toBe(false);
    expect(verifyWhatsAppSignature("other-secret", sign(BODY), BODY)).toBe(false);
    expect(verifyWhatsAppSignature(SECRET, "", BODY)).toBe(false);
    expect(verifyWhatsAppSignature(SECRET, "md5=abc", BODY)).toBe(false);
    expect(verifyWhatsAppSignature("", sign(BODY), BODY)).toBe(false);
  });
});

describe("WhatsApp id ↔ E.164", () => {
  test("round-trips digits, stripping/adding the + and any separators", () => {
    expect(whatsappIdToE164("14245074963")).toBe("+14245074963");
    expect(e164ToWhatsappId("+14245074963")).toBe("14245074963");
    expect(e164ToWhatsappId(whatsappIdToE164("14245074963"))).toBe("14245074963");
    expect(whatsappIdToE164("+1 (424) 507-4963")).toBe("+14245074963");
  });

  test("isValidWhatsAppId requires 7-15 digits, no symbols", () => {
    expect(isValidWhatsAppId("14245074963")).toBe(true);
    expect(isValidWhatsAppId("123456")).toBe(false); // too short
    expect(isValidWhatsAppId("1234567890123456")).toBe(false); // too long
    expect(isValidWhatsAppId("+14245074963")).toBe(false); // has +
  });
});

describe("sendWhatsAppTypingIndicator diagnostics", () => {
  test("does not log provider-controlled identifiers or error bodies", async () => {
    const sentinelPhoneNumberId = "SENTINEL_WHATSAPP_PHONE_NUMBER_ID";
    const sentinelMessageId = "SENTINEL_WHATSAPP_MESSAGE_ID";
    const sentinelErrorBody = "SENTINEL_WHATSAPP_TYPING_ERROR_BODY";
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error(sentinelErrorBody));
    const loggerDebug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    try {
      await sendWhatsAppTypingIndicator(
        "test-access-token",
        sentinelPhoneNumberId,
        sentinelMessageId,
      );

      const serializedLogs = JSON.stringify(loggerDebug.mock.calls);
      expect(serializedLogs).not.toContain(sentinelPhoneNumberId);
      expect(serializedLogs).not.toContain(sentinelMessageId);
      expect(serializedLogs).not.toContain(sentinelErrorBody);
      expect(loggerDebug).toHaveBeenCalledWith("[WhatsApp] Failed to send typing indicator", {
        failureClass: "typing_indicator_failed",
      });
    } finally {
      globalThis.fetch = originalFetch;
      loggerDebug.mockRestore();
    }
  });
});
