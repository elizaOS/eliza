// Exercises whatsapp api behavior with deterministic cloud-shared lib fixtures.
import crypto from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  e164ToWhatsappId,
  isValidWhatsAppId,
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
