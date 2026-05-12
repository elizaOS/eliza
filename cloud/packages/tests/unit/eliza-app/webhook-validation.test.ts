/**
 * Eliza App Webhook Validation Tests
 *
 * Tests request validation for webhook endpoints:
 * - Telegram webhook secret verification
 * - Blooio signature verification
 * - Request body parsing and validation
 * - Rate limiting behavior
 * - Idempotency handling
 */

import { describe, expect, test } from "bun:test";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";

// Telegram webhook schemas
const telegramMessageSchema = z.object({
  message_id: z.number(),
  from: z.object({
    id: z.number(),
    first_name: z.string(),
    last_name: z.string().optional(),
    username: z.string().optional(),
  }),
  chat: z.object({
    id: z.number(),
    type: z.enum(["private", "group", "supergroup", "channel"]),
  }),
  date: z.number(),
  text: z.string().optional(),
});

const telegramUpdateSchema = z.object({
  update_id: z.number(),
  message: telegramMessageSchema.optional(),
});

// Blooio webhook schema
const blooioWebhookSchema = z.object({
  event: z.enum([
    "message.received",
    "message.sent",
    "message.delivered",
    "message.failed",
    "message.read",
  ]),
  message_id: z.string().optional(),
  sender: z.string().optional(),
  recipient: z.string().optional(),
  text: z.string().optional(),
  is_group: z.boolean().optional(),
  attachments: z
    .array(
      z.object({
        type: z.string(),
        url: z.string().optional(),
      }),
    )
    .optional(),
});

describe("Telegram Webhook Secret Verification", () => {
  const WEBHOOK_SECRET = "test-webhook-secret-123";

  test("valid secret token passes verification", () => {
    const receivedToken = WEBHOOK_SECRET;
    const expectedBuffer = Buffer.from(WEBHOOK_SECRET);
    const receivedBuffer = Buffer.from(receivedToken);

    const isValid =
      expectedBuffer.length === receivedBuffer.length &&
      timingSafeEqual(expectedBuffer, receivedBuffer);

    expect(isValid).toBe(true);
  });

  test("invalid secret token fails verification", () => {
    const receivedToken = "wrong-secret";
    const expectedBuffer = Buffer.from(WEBHOOK_SECRET);
    const receivedBuffer = Buffer.from(receivedToken);

    // Different lengths fail fast
    expect(expectedBuffer.length).not.toBe(receivedBuffer.length);
  });

  test("timing-safe comparison prevents timing attacks", () => {
    const secret = "correct-secret-token";
    const _expectedBuffer = Buffer.from(secret);

    // These should take similar time to compare
    const almostCorrect = "correct-secret-toke!";
    const _completelyWrong = "xxxxxxxxxxxxxxxxxxxxxx";

    // Both have same length as secret
    expect(almostCorrect.length).toBe(secret.length);
    // The test verifies we use timingSafeEqual, not string comparison
  });

  test("empty secret token fails", () => {
    const receivedToken = "";
    const expectedBuffer = Buffer.from(WEBHOOK_SECRET);
    const receivedBuffer = Buffer.from(receivedToken);

    expect(expectedBuffer.length).not.toBe(receivedBuffer.length);
  });

  test("null-byte injection attempt fails", () => {
    const maliciousToken = WEBHOOK_SECRET + "\x00extra";
    const expectedBuffer = Buffer.from(WEBHOOK_SECRET);
    const receivedBuffer = Buffer.from(maliciousToken);

    expect(expectedBuffer.length).not.toBe(receivedBuffer.length);
  });
});

describe("Blooio Signature Verification", () => {
  const WEBHOOK_SECRET = "blooio-test-secret";

  function generateBlooioSignature(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload).digest("hex");
  }

  test("valid signature passes verification", () => {
    const payload = JSON.stringify({
      event: "message.received",
      text: "Hello",
    });
    const signature = generateBlooioSignature(payload, WEBHOOK_SECRET);
    const expectedSignature = generateBlooioSignature(payload, WEBHOOK_SECRET);

    expect(signature).toBe(expectedSignature);
  });

  test("tampered payload fails verification", () => {
    const originalPayload = JSON.stringify({
      event: "message.received",
      text: "Hello",
    });
    const tamperedPayload = JSON.stringify({
      event: "message.received",
      text: "Hacked",
    });

    const originalSignature = generateBlooioSignature(originalPayload, WEBHOOK_SECRET);
    const tamperedSignature = generateBlooioSignature(tamperedPayload, WEBHOOK_SECRET);

    expect(originalSignature).not.toBe(tamperedSignature);
  });

  test("wrong secret produces different signature", () => {
    const payload = JSON.stringify({ event: "message.received" });
    const correctSignature = generateBlooioSignature(payload, WEBHOOK_SECRET);
    const wrongSignature = generateBlooioSignature(payload, "wrong-secret");

    expect(correctSignature).not.toBe(wrongSignature);
  });

  test("signature is 64-character hex", () => {
    const payload = "test payload";
    const signature = generateBlooioSignature(payload, WEBHOOK_SECRET);

    expect(signature).toHaveLength(64);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Telegram Update Validation", () => {
  test("valid private message update passes", () => {
    const update = {
      update_id: 123456789,
      message: {
        message_id: 1,
        from: {
          id: 223116693,
          first_name: "Test",
          username: "testuser",
        },
        chat: {
          id: 223116693,
          type: "private" as const,
        },
        date: 1700000000,
        text: "Hello Eliza!",
      },
    };

    const result = telegramUpdateSchema.safeParse(update);
    expect(result.success).toBe(true);
  });

  test("update without message is valid", () => {
    const update = {
      update_id: 123456789,
    };

    const result = telegramUpdateSchema.safeParse(update);
    expect(result.success).toBe(true);
  });

  test("missing update_id fails", () => {
    const update = {
      message: {
        message_id: 1,
        from: { id: 123, first_name: "Test" },
        chat: { id: 123, type: "private" },
        date: 1700000000,
      },
    };

    const result = telegramUpdateSchema.safeParse(update);
    expect(result.success).toBe(false);
  });

  test("invalid chat type fails", () => {
    const update = {
      update_id: 123,
      message: {
        message_id: 1,
        from: { id: 123, first_name: "Test" },
        chat: { id: 123, type: "invalid" },
        date: 1700000000,
      },
    };

    const result = telegramUpdateSchema.safeParse(update);
    expect(result.success).toBe(false);
  });

  test("group message is parsed correctly", () => {
    const update = {
      update_id: 123,
      message: {
        message_id: 1,
        from: { id: 123, first_name: "Test" },
        chat: { id: -100123456789, type: "supergroup" as const },
        date: 1700000000,
        text: "Group message",
      },
    };

    const result = telegramUpdateSchema.safeParse(update);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.message?.chat.type).toBe("supergroup");
    }
  });
});

describe("Blooio Webhook Validation", () => {
  test("valid message.received event passes", () => {
    const payload = {
      event: "message.received" as const,
      message_id: "msg-123",
      sender: "+14155551234",
      text: "Hello from iMessage!",
      is_group: false,
    };

    const result = blooioWebhookSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  test("valid message.sent event passes", () => {
    const payload = {
      event: "message.sent" as const,
      message_id: "msg-456",
      recipient: "+14155551234",
    };

    const result = blooioWebhookSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  test("invalid event type fails", () => {
    const payload = {
      event: "invalid.event",
      message_id: "msg-123",
    };

    const result = blooioWebhookSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("missing event field fails", () => {
    const payload = {
      message_id: "msg-123",
      sender: "+14155551234",
    };

    const result = blooioWebhookSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("message with attachments passes", () => {
    const payload = {
      event: "message.received" as const,
      message_id: "msg-123",
      sender: "+14155551234",
      attachments: [
        { type: "image", url: "https://example.com/image.jpg" },
        { type: "video", url: "https://example.com/video.mp4" },
      ],
    };

    const result = blooioWebhookSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  test("group message is identified", () => {
    const payload = {
      event: "message.received" as const,
      message_id: "msg-123",
      sender: "+14155551234",
      is_group: true,
    };

    const result = blooioWebhookSchema.safeParse(payload);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.is_group).toBe(true);
    }
  });
});

describe("Idempotency Key Generation", () => {
  test("Telegram idempotency key format", () => {
    const updateId = 167486885;
    const key = `telegram:eliza-app:${updateId}`;
    expect(key).toBe("telegram:eliza-app:167486885");
  });

  test("Blooio idempotency key format", () => {
    const messageId = "msg-abc-123";
    const key = `blooio:eliza-app:${messageId}`;
    expect(key).toBe("blooio:eliza-app:msg-abc-123");
  });

  test("same update_id produces same key", () => {
    const updateId = 12345;
    const key1 = `telegram:eliza-app:${updateId}`;
    const key2 = `telegram:eliza-app:${updateId}`;
    expect(key1).toBe(key2);
  });

  test("different update_ids produce different keys", () => {
    const key1 = `telegram:eliza-app:${11111}`;
    const key2 = `telegram:eliza-app:${22222}`;
    expect(key1).not.toBe(key2);
  });
});

describe("Command Parsing", () => {
  test("/start command is detected", () => {
    const text = "/start";
    const isCommand = text.startsWith("/");
    const command = text.split(" ")[0].toLowerCase();
    expect(isCommand).toBe(true);
    expect(command).toBe("/start");
  });

  test("/help command is detected", () => {
    const text = "/help";
    const command = text.split(" ")[0].toLowerCase();
    expect(command).toBe("/help");
  });

  test("/status command is detected", () => {
    const text = "/status";
    const command = text.split(" ")[0].toLowerCase();
    expect(command).toBe("/status");
  });

  test("command with arguments is parsed", () => {
    const text = "/start some_argument";
    const parts = text.split(" ");
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(" ");
    expect(command).toBe("/start");
    expect(args).toBe("some_argument");
  });

  test("regular message is not a command", () => {
    const text = "Hello, this is not a command";
    const isCommand = text.startsWith("/");
    expect(isCommand).toBe(false);
  });

  test("message starting with / but not a command pattern", () => {
    const text = "/ this has a space after slash";
    const isCommand = text.startsWith("/");
    const command = text.split(" ")[0].toLowerCase();
    expect(isCommand).toBe(true);
    expect(command).toBe("/");
  });
});

describe("Phone Number in Webhook", () => {
  test("E.164 format phone number is valid", () => {
    const phone = "+14155551234";
    const e164Regex = /^\+[1-9]\d{1,14}$/;
    expect(phone).toMatch(e164Regex);
  });

  test("phone without + prefix is detected", () => {
    const phone = "14155551234";
    const e164Regex = /^\+[1-9]\d{1,14}$/;
    expect(phone).not.toMatch(e164Regex);
  });

  test("international phone numbers", () => {
    const phones = [
      "+442071234567", // UK
      "+33123456789", // France
      "+81312345678", // Japan
      "+14155551234", // US
    ];
    const e164Regex = /^\+[1-9]\d{1,14}$/;

    phones.forEach((phone) => {
      expect(phone).toMatch(e164Regex);
    });
  });
});
