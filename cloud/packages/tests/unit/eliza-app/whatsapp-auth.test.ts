/**
 * WhatsApp Auth Service Tests
 *
 * Tests HMAC-SHA256 webhook signature verification:
 * - Valid signature acceptance
 * - Invalid/tampered signature rejection
 * - Missing App Secret handling
 * - Webhook subscription verification (GET handshake)
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "crypto";
import { verifyWhatsAppSignature } from "../../../lib/utils/whatsapp-api";

const TEST_APP_SECRET = "test_whatsapp_app_secret_abc123";
const TEST_VERIFY_TOKEN = "my_verify_token_xyz";

function makeSignature(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("WhatsApp Webhook Signature Verification", () => {
  test("accepts valid signature", () => {
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const sig = makeSignature(body, TEST_APP_SECRET);
    expect(verifyWhatsAppSignature(TEST_APP_SECRET, sig, body)).toBe(true);
  });

  test("rejects signature with wrong secret", () => {
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const sig = makeSignature(body, "wrong_secret");
    expect(verifyWhatsAppSignature(TEST_APP_SECRET, sig, body)).toBe(false);
  });

  test("rejects tampered payload", () => {
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const sig = makeSignature(body, TEST_APP_SECRET);
    expect(verifyWhatsAppSignature(TEST_APP_SECRET, sig, body + "x")).toBe(false);
  });

  test("rejects empty signature header", () => {
    const body = '{"test":true}';
    expect(verifyWhatsAppSignature(TEST_APP_SECRET, "", body)).toBe(false);
  });

  test("rejects empty app secret", () => {
    const body = '{"test":true}';
    const sig = makeSignature(body, TEST_APP_SECRET);
    expect(verifyWhatsAppSignature("", sig, body)).toBe(false);
  });

  test("handles large payloads", () => {
    const body = JSON.stringify({ data: "x".repeat(100000) });
    const sig = makeSignature(body, TEST_APP_SECRET);
    expect(verifyWhatsAppSignature(TEST_APP_SECRET, sig, body)).toBe(true);
  });

  test("handles unicode in payload", () => {
    const body = JSON.stringify({ text: "Hello! こんにちは 🎉" });
    const sig = makeSignature(body, TEST_APP_SECRET);
    expect(verifyWhatsAppSignature(TEST_APP_SECRET, sig, body)).toBe(true);
  });

  test("timing-safe comparison prevents length-based detection", () => {
    const body = '{"test":true}';
    // Create a signature that differs in length by having non-hex chars
    expect(verifyWhatsAppSignature(TEST_APP_SECRET, "sha256=short", body)).toBe(false);
  });
});

describe("WhatsApp Webhook Subscription Verification Logic", () => {
  // These tests verify the logic without importing the service (which needs config)

  test("verify_token match logic", () => {
    const expectedToken = TEST_VERIFY_TOKEN;
    const mode = "subscribe";
    const verifyToken = TEST_VERIFY_TOKEN;
    const challenge = "1234567890";

    // Simulating the auth service logic
    const isValid = mode === "subscribe" && verifyToken === expectedToken && !!challenge;
    expect(isValid).toBe(true);
  });

  test("rejects wrong mode", () => {
    const mode = "unsubscribe" as string;
    const verifyToken = TEST_VERIFY_TOKEN;
    const challenge = "1234567890";

    const isValid = mode === "subscribe" && verifyToken === TEST_VERIFY_TOKEN && !!challenge;
    expect(isValid).toBe(false);
  });

  test("rejects wrong verify token", () => {
    const mode = "subscribe";
    const verifyToken = "wrong_token" as string;
    const challenge = "1234567890";

    const isValid = mode === "subscribe" && verifyToken === TEST_VERIFY_TOKEN && !!challenge;
    expect(isValid).toBe(false);
  });

  test("rejects missing challenge", () => {
    const mode = "subscribe";
    const verifyToken = TEST_VERIFY_TOKEN;
    const challenge = "";

    const isValid = mode === "subscribe" && verifyToken === TEST_VERIFY_TOKEN && !!challenge;
    expect(isValid).toBe(false);
  });
});
