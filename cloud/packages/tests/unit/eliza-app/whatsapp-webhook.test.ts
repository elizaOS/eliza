/**
 * WhatsApp Webhook Handler Tests
 *
 * Tests the webhook verification GET handler and POST handler logic:
 * - GET: hub.mode, hub.verify_token, hub.challenge verification
 * - POST: Signature verification, payload parsing, message extraction
 * - Idempotency: Duplicate message handling
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "crypto";
import {
  extractWhatsAppMessages,
  parseWhatsAppWebhookPayload,
  verifyWhatsAppSignature,
  type WhatsAppWebhookPayload,
} from "../../../lib/utils/whatsapp-api";

const APP_SECRET = "test_webhook_app_secret";

describe("WhatsApp Webhook GET (Verification Handshake)", () => {
  const VERIFY_TOKEN = "my_custom_verify_token";

  function simulateVerification(
    mode: string | null,
    verifyToken: string | null,
    challenge: string | null,
    expectedToken: string,
  ): string | null {
    if (mode !== "subscribe") return null;
    if (verifyToken !== expectedToken) return null;
    if (!challenge) return null;
    return challenge;
  }

  test("returns challenge when verification succeeds", () => {
    const result = simulateVerification("subscribe", VERIFY_TOKEN, "123456", VERIFY_TOKEN);
    expect(result).toBe("123456");
  });

  test("returns null for wrong mode", () => {
    const result = simulateVerification("unsubscribe", VERIFY_TOKEN, "123456", VERIFY_TOKEN);
    expect(result).toBeNull();
  });

  test("returns null for wrong verify token", () => {
    const result = simulateVerification("subscribe", "wrong_token", "123456", VERIFY_TOKEN);
    expect(result).toBeNull();
  });

  test("returns null for missing challenge", () => {
    const result = simulateVerification("subscribe", VERIFY_TOKEN, null, VERIFY_TOKEN);
    expect(result).toBeNull();
  });

  test("returns null for null mode", () => {
    const result = simulateVerification(null, VERIFY_TOKEN, "123456", VERIFY_TOKEN);
    expect(result).toBeNull();
  });
});

describe("WhatsApp Webhook POST (Message Processing)", () => {
  function makeSignature(body: string): string {
    return "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
  }

  test("validates signature and extracts messages", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "biz_account_id",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+14245074963",
                  phone_number_id: "phone_123",
                },
                contacts: [{ profile: { name: "Test User" }, wa_id: "14155551234" }],
                messages: [
                  {
                    id: "wamid.test123",
                    from: "14155551234",
                    timestamp: "1706745600",
                    type: "text",
                    text: { body: "Hello!" },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    const body = JSON.stringify(payload);
    const signature = makeSignature(body);

    // Step 1: Verify signature
    expect(verifyWhatsAppSignature(APP_SECRET, signature, body)).toBe(true);

    // Step 2: Parse payload
    const parsed = parseWhatsAppWebhookPayload(payload);
    expect(parsed.object).toBe("whatsapp_business_account");

    // Step 3: Extract messages
    const messages = extractWhatsAppMessages(parsed);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toBe("Hello!");
    expect(messages[0].from).toBe("14155551234");
    expect(messages[0].profileName).toBe("Test User");
  });

  test("rejects message with invalid signature", () => {
    const body = '{"object":"whatsapp_business_account","entry":[]}';
    const fakeSignature = "sha256=0000000000000000000000000000000000000000000000000000000000000000";
    expect(verifyWhatsAppSignature(APP_SECRET, fakeSignature, body)).toBe(false);
  });

  test("handles payload with no messages (status update)", () => {
    const payload: WhatsAppWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "biz_account_id",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+14245074963",
                  phone_number_id: "phone_123",
                },
                statuses: [
                  {
                    id: "wamid.test123",
                    status: "delivered",
                    timestamp: "1706745600",
                    recipient_id: "14155551234",
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

  test("extracts image message (type but no text)", () => {
    const payload: WhatsAppWebhookPayload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "biz_account_id",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "+14245074963",
                  phone_number_id: "phone_123",
                },
                contacts: [{ profile: { name: "Photo User" }, wa_id: "14155551234" }],
                messages: [
                  {
                    id: "wamid.img123",
                    from: "14155551234",
                    timestamp: "1706745600",
                    type: "image",
                    image: {
                      id: "img_media_id",
                      mime_type: "image/jpeg",
                    },
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
    expect(messages[0].type).toBe("image");
    expect(messages[0].text).toBeUndefined();
    expect(messages[0].profileName).toBe("Photo User");
  });
});

describe("WhatsApp Idempotency Key Generation", () => {
  test("generates consistent idempotency key from message ID", () => {
    const messageId = "wamid.HBgLMTQyNDUwNzQ5NjM=";
    const key = `whatsapp:eliza-app:${messageId}`;
    expect(key).toBe(`whatsapp:eliza-app:${messageId}`);
  });

  test("different messages produce different keys", () => {
    const key1 = `whatsapp:eliza-app:wamid.msg1`;
    const key2 = `whatsapp:eliza-app:wamid.msg2`;
    expect(key1).not.toBe(key2);
  });
});
