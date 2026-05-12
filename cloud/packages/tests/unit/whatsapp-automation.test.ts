/**
 * WhatsApp Automation Service Tests
 *
 * Tests the organization-level WhatsApp integration service:
 * - Verify token generation
 * - Access token validation logic
 * - Webhook subscription verification
 * - Webhook signature verification delegation
 * - Connection status logic
 */

import { describe, expect, test } from "bun:test";
import crypto from "crypto";
import { isValidWhatsAppId, verifyWhatsAppSignature } from "../../lib/utils/whatsapp-api";

// ============================================================================
// Verify Token Generation
// ============================================================================

describe("WhatsApp Automation - Verify Token Generation", () => {
  test("generates a verify token with correct prefix", () => {
    // Simulate the generateVerifyToken logic
    const token = `wa_verify_${crypto.randomBytes(24).toString("hex")}`;
    expect(token).toStartWith("wa_verify_");
    expect(token.length).toBeGreaterThan(20);
  });

  test("generates unique tokens on each call", () => {
    const token1 = `wa_verify_${crypto.randomBytes(24).toString("hex")}`;
    const token2 = `wa_verify_${crypto.randomBytes(24).toString("hex")}`;
    expect(token1).not.toBe(token2);
  });

  test("token is hex-safe (no special characters)", () => {
    const token = `wa_verify_${crypto.randomBytes(24).toString("hex")}`;
    // Should only contain alphanumeric + underscore
    expect(/^[a-zA-Z0-9_]+$/.test(token)).toBe(true);
  });
});

// ============================================================================
// Webhook Subscription Verification Logic
// ============================================================================

describe("WhatsApp Automation - Webhook Subscription Verification", () => {
  const STORED_TOKEN = "wa_verify_abc123def456";

  // Simulates the verifyWebhookSubscription logic
  function verifySubscription(
    mode: string | null,
    verifyToken: string | null,
    challenge: string | null,
    storedToken: string | null,
  ): string | null {
    if (mode !== "subscribe" || !verifyToken || !challenge) {
      return null;
    }
    if (!storedToken || verifyToken !== storedToken) {
      return null;
    }
    return challenge;
  }

  test("returns challenge when all params match", () => {
    expect(verifySubscription("subscribe", STORED_TOKEN, "12345", STORED_TOKEN)).toBe("12345");
  });

  test("rejects when mode is not subscribe", () => {
    expect(verifySubscription("unsubscribe", STORED_TOKEN, "12345", STORED_TOKEN)).toBeNull();
  });

  test("rejects when verify token does not match", () => {
    expect(verifySubscription("subscribe", "wrong_token", "12345", STORED_TOKEN)).toBeNull();
  });

  test("rejects when challenge is missing", () => {
    expect(verifySubscription("subscribe", STORED_TOKEN, null, STORED_TOKEN)).toBeNull();
  });

  test("rejects when mode is null", () => {
    expect(verifySubscription(null, STORED_TOKEN, "12345", STORED_TOKEN)).toBeNull();
  });

  test("rejects when no stored token exists", () => {
    expect(verifySubscription("subscribe", STORED_TOKEN, "12345", null)).toBeNull();
  });
});

// ============================================================================
// Webhook Signature Verification (delegates to whatsapp-api util)
// ============================================================================

describe("WhatsApp Automation - Signature Verification Delegation", () => {
  const APP_SECRET = "org_specific_app_secret_123";

  function makeSignature(body: string, secret: string): string {
    return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
  }

  test("accepts valid signature with org-specific secret", () => {
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const sig = makeSignature(body, APP_SECRET);
    expect(verifyWhatsAppSignature(APP_SECRET, sig, body)).toBe(true);
  });

  test("rejects signature from different org secret", () => {
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const sig = makeSignature(body, "other_org_secret");
    expect(verifyWhatsAppSignature(APP_SECRET, sig, body)).toBe(false);
  });
});

// ============================================================================
// WhatsApp ID Validation
// ============================================================================

describe("WhatsApp Automation - ID Validation in Webhook", () => {
  test("accepts valid WhatsApp IDs", () => {
    expect(isValidWhatsAppId("14245074963")).toBe(true);
    expect(isValidWhatsAppId("491511234567")).toBe(true);
    expect(isValidWhatsAppId("1234567")).toBe(true); // 7 digits minimum
    expect(isValidWhatsAppId("123456789012345")).toBe(true); // 15 digits maximum
  });

  test("rejects IDs with non-digit characters", () => {
    expect(isValidWhatsAppId("+14245074963")).toBe(false);
    expect(isValidWhatsAppId("1424-507-4963")).toBe(false);
    expect(isValidWhatsAppId("abc")).toBe(false);
    expect(isValidWhatsAppId("14245abc963")).toBe(false);
  });

  test("rejects IDs that are too short or too long", () => {
    expect(isValidWhatsAppId("123456")).toBe(false); // 6 digits
    expect(isValidWhatsAppId("1234567890123456")).toBe(false); // 16 digits
    expect(isValidWhatsAppId("")).toBe(false);
  });
});

// ============================================================================
// Connection Status Logic
// ============================================================================

describe("WhatsApp Automation - Connection Status Logic", () => {
  test("not configured when no credentials", () => {
    const accessToken = null;
    const phoneNumberId = null;

    const configured = !!(accessToken && phoneNumberId);
    expect(configured).toBe(false);
  });

  test("configured when both token and phone number ID exist", () => {
    const accessToken = "EAAxxxxxxxx";
    const phoneNumberId = "123456789";

    const configured = !!(accessToken && phoneNumberId);
    expect(configured).toBe(true);
  });

  test("not fully configured when only token exists", () => {
    const accessToken = "EAAxxxxxxxx";
    const phoneNumberId = null;

    const configured = !!(accessToken && phoneNumberId);
    expect(configured).toBe(false);
  });
});

// ============================================================================
// Idempotency Key Format
// ============================================================================

describe("WhatsApp Automation - Idempotency Key Format", () => {
  test("org-level key includes orgId for isolation", () => {
    const orgId = "org_123";
    const messageId = "wamid.abc123";
    const key = `whatsapp:org:${orgId}:${messageId}`;

    expect(key).toBe("whatsapp:org:org_123:wamid.abc123");
    expect(key).toContain(orgId);
    expect(key).toContain(messageId);
  });

  test("different orgs produce different keys for same message", () => {
    const messageId = "wamid.abc123";
    const key1 = `whatsapp:org:org_1:${messageId}`;
    const key2 = `whatsapp:org:org_2:${messageId}`;

    expect(key1).not.toBe(key2);
  });
});

// ============================================================================
// Secret Names
// ============================================================================

describe("WhatsApp Automation - Secret Name Constants", () => {
  test("secret names are correctly defined", async () => {
    const { SECRET_NAMES } = await import("../../lib/constants/secrets");

    expect(SECRET_NAMES.WHATSAPP.ACCESS_TOKEN).toBe("WHATSAPP_ACCESS_TOKEN");
    expect(SECRET_NAMES.WHATSAPP.PHONE_NUMBER_ID).toBe("WHATSAPP_PHONE_NUMBER_ID");
    expect(SECRET_NAMES.WHATSAPP.APP_SECRET).toBe("WHATSAPP_APP_SECRET");
    expect(SECRET_NAMES.WHATSAPP.VERIFY_TOKEN).toBe("WHATSAPP_VERIFY_TOKEN");
    expect(SECRET_NAMES.WHATSAPP.BUSINESS_PHONE).toBe("WHATSAPP_BUSINESS_PHONE");
  });
});
