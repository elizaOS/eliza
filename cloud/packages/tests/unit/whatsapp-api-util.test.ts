/**
 * WhatsApp API Utility Tests
 *
 * Tests for:
 * - Webhook signature verification (HMAC-SHA256)
 * - Webhook payload parsing and validation
 * - Message extraction from nested payloads
 * - Phone number formatting (WhatsApp ID <-> E.164)
 * - WhatsApp ID validation
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "crypto";
import {
  e164ToWhatsappId,
  extractWhatsAppMessages,
  isValidWhatsAppId,
  parseWhatsAppWebhookPayload,
  verifyWhatsAppSignature,
  type WhatsAppWebhookPayload,
  whatsappIdToE164,
} from "../../lib/utils/whatsapp-api";

// ============================================================================
// Webhook Signature Verification
// ============================================================================

describe("WhatsApp Webhook Signature Verification", () => {
  const APP_SECRET = "test_app_secret_12345";

  function generateSignature(body: string, secret: string): string {
    return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  }

  test("accepts valid signature", () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [],
    });
    const signature = generateSignature(body, APP_SECRET);
    expect(verifyWhatsAppSignature(APP_SECRET, signature, body)).toBe(true);
  });

  test("rejects invalid signature", () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [],
    });
    const signature = "sha256=0000000000000000000000000000000000000000000000000000000000000000";
    expect(verifyWhatsAppSignature(APP_SECRET, signature, body)).toBe(false);
  });

  test("rejects tampered body", () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [],
    });
    const signature = generateSignature(body, APP_SECRET);
    const tamperedBody = body + "tampered";
    expect(verifyWhatsAppSignature(APP_SECRET, signature, tamperedBody)).toBe(false);
  });

  test("rejects wrong app secret", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    const signature = generateSignature(body, APP_SECRET);
    expect(verifyWhatsAppSignature("wrong_secret", signature, body)).toBe(false);
  });

  test("rejects empty signature header", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    expect(verifyWhatsAppSignature(APP_SECRET, "", body)).toBe(false);
  });

  test("rejects empty app secret", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    const signature = generateSignature(body, APP_SECRET);
    expect(verifyWhatsAppSignature("", signature, body)).toBe(false);
  });

  test("rejects signature without sha256= prefix", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account" });
    const rawHash = createHmac("sha256", APP_SECRET).update(body).digest("hex");
    // Without the "sha256=" prefix, the hex should not match
    expect(verifyWhatsAppSignature(APP_SECRET, rawHash, body)).toBe(false);
  });
});

// ============================================================================
// Webhook Payload Parsing
// ============================================================================

describe("WhatsApp Webhook Payload Parsing", () => {
  const validPayload = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "123456789",
        changes: [
          {
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "+14245074963",
                phone_number_id: "phone_id_123",
              },
              contacts: [
                {
                  profile: { name: "John Doe" },
                  wa_id: "14245071234",
                },
              ],
              messages: [
                {
                  id: "wamid.abc123",
                  from: "14245071234",
                  timestamp: "1706745600",
                  type: "text",
                  text: { body: "Hello Eliza!" },
                },
              ],
            },
            field: "messages",
          },
        ],
      },
    ],
  };

  test("parses valid payload", () => {
    const result = parseWhatsAppWebhookPayload(validPayload);
    expect(result.object).toBe("whatsapp_business_account");
    expect(result.entry).toHaveLength(1);
    expect(result.entry[0].changes[0].value.messaging_product).toBe("whatsapp");
  });

  test("rejects payload with wrong object type", () => {
    expect(() => parseWhatsAppWebhookPayload({ ...validPayload, object: "page" })).toThrow();
  });

  test("rejects payload with missing entry", () => {
    expect(() => parseWhatsAppWebhookPayload({ object: "whatsapp_business_account" })).toThrow();
  });

  test("rejects invalid JSON structure", () => {
    expect(() => parseWhatsAppWebhookPayload("not an object")).toThrow();
    expect(() => parseWhatsAppWebhookPayload(null)).toThrow();
    expect(() => parseWhatsAppWebhookPayload(123)).toThrow();
  });

  test("parses payload with status updates (no messages)", () => {
    const statusPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "123456789",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+14245074963",
                  phone_number_id: "phone_id_123",
                },
                statuses: [
                  {
                    id: "wamid.abc123",
                    status: "delivered",
                    timestamp: "1706745600",
                    recipient_id: "14245071234",
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    const result = parseWhatsAppWebhookPayload(statusPayload);
    expect(result.entry[0].changes[0].value.statuses).toHaveLength(1);
  });
});

// ============================================================================
// Message Extraction
// ============================================================================

describe("WhatsApp Message Extraction", () => {
  test("extracts text message with profile name", () => {
    const payload: WhatsAppWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "123456789",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+14245074963",
                  phone_number_id: "phone_id_123",
                },
                contacts: [
                  {
                    profile: { name: "John Doe" },
                    wa_id: "14245071234",
                  },
                ],
                messages: [
                  {
                    id: "wamid.abc123",
                    from: "14245071234",
                    timestamp: "1706745600",
                    type: "text",
                    text: { body: "Hello Eliza!" },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    const messages = extractWhatsAppMessages(payload);
    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe("wamid.abc123");
    expect(messages[0].from).toBe("14245071234");
    expect(messages[0].text).toBe("Hello Eliza!");
    expect(messages[0].profileName).toBe("John Doe");
    expect(messages[0].phoneNumberId).toBe("phone_id_123");
    expect(messages[0].type).toBe("text");
  });

  test("returns empty array for status-only payloads", () => {
    const payload: WhatsAppWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "123456789",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+14245074963",
                  phone_number_id: "phone_id_123",
                },
                statuses: [
                  {
                    id: "wamid.abc123",
                    status: "delivered",
                    timestamp: "1706745600",
                    recipient_id: "14245071234",
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    const messages = extractWhatsAppMessages(payload);
    expect(messages).toHaveLength(0);
  });

  test("extracts multiple messages", () => {
    const payload: WhatsAppWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "123456789",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+14245074963",
                  phone_number_id: "phone_id_123",
                },
                contacts: [{ profile: { name: "User A" }, wa_id: "14245071111" }],
                messages: [
                  {
                    id: "wamid.msg1",
                    from: "14245071111",
                    timestamp: "1706745600",
                    type: "text",
                    text: { body: "First message" },
                  },
                  {
                    id: "wamid.msg2",
                    from: "14245071111",
                    timestamp: "1706745601",
                    type: "text",
                    text: { body: "Second message" },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    const messages = extractWhatsAppMessages(payload);
    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe("First message");
    expect(messages[1].text).toBe("Second message");
  });

  test("skips non-messages field changes", () => {
    const payload: WhatsAppWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "123456789",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+14245074963",
                  phone_number_id: "phone_id_123",
                },
              },
              field: "account_update",
            },
          ],
        },
      ],
    };

    const messages = extractWhatsAppMessages(payload);
    expect(messages).toHaveLength(0);
  });
});

// ============================================================================
// Phone Number Formatting
// ============================================================================

describe("WhatsApp Phone Number Formatting", () => {
  test("whatsappIdToE164 adds + prefix", () => {
    expect(whatsappIdToE164("14245074963")).toBe("+14245074963");
    expect(whatsappIdToE164("447700900000")).toBe("+447700900000");
  });

  test("whatsappIdToE164 strips non-digit characters", () => {
    expect(whatsappIdToE164("+14245074963")).toBe("+14245074963");
    expect(whatsappIdToE164("1-424-507-4963")).toBe("+14245074963");
  });

  test("e164ToWhatsappId removes + prefix", () => {
    expect(e164ToWhatsappId("+14245074963")).toBe("14245074963");
    expect(e164ToWhatsappId("+447700900000")).toBe("447700900000");
  });

  test("e164ToWhatsappId handles already-clean IDs", () => {
    expect(e164ToWhatsappId("14245074963")).toBe("14245074963");
  });

  test("roundtrip conversion", () => {
    const originalId = "14245074963";
    expect(e164ToWhatsappId(whatsappIdToE164(originalId))).toBe(originalId);
  });
});

// ============================================================================
// WhatsApp ID Validation
// ============================================================================

describe("WhatsApp ID Validation", () => {
  test("accepts valid WhatsApp IDs", () => {
    expect(isValidWhatsAppId("14245074963")).toBe(true); // US number
    expect(isValidWhatsAppId("447700900000")).toBe(true); // UK number
    expect(isValidWhatsAppId("8613800138000")).toBe(true); // China number
    expect(isValidWhatsAppId("1234567")).toBe(true); // Minimum length
  });

  test("rejects invalid WhatsApp IDs", () => {
    expect(isValidWhatsAppId("")).toBe(false); // Empty
    expect(isValidWhatsAppId("123456")).toBe(false); // Too short (6 digits)
    expect(isValidWhatsAppId("1234567890123456")).toBe(false); // Too long (16 digits)
    expect(isValidWhatsAppId("+14245074963")).toBe(false); // Has + prefix
    expect(isValidWhatsAppId("1-424-507-4963")).toBe(false); // Has dashes
    expect(isValidWhatsAppId("abc1234567")).toBe(false); // Has letters
  });
});
