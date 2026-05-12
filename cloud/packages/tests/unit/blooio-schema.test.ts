/**
 * Blooio Schema Validation Tests
 *
 * Tests that the Blooio webhook schema correctly handles explicit null values.
 * This is critical because Blooio sends "text": null instead of omitting the field.
 */

import { describe, expect, it } from "bun:test";
import { ZodError } from "zod";
import { parseBlooioWebhookEvent } from "../../lib/utils/blooio-api";

describe("Blooio Webhook Schema", () => {
  describe("nullish field handling", () => {
    it("should accept event with explicit null values (Blooio actual format)", () => {
      // This is the actual format Blooio sends - explicit nulls, not omitted fields
      const blooioPayload = {
        event: "message_received",
        message_id: null,
        external_id: "chat-123",
        internal_id: null,
        sender: "+15551234567",
        text: null, // Blooio sends null for empty text, not undefined
        attachments: null,
        protocol: "imessage",
        is_group: null,
        received_at: 1706745600,
        timestamp: null,
      };

      const result = parseBlooioWebhookEvent(blooioPayload);

      expect(result.event).toBe("message_received");
      expect(result.text).toBeNull();
      expect(result.message_id).toBeNull();
      expect(result.attachments).toBeNull();
      expect(result.sender).toBe("+15551234567");
    });

    it("should accept event with omitted fields (standard optional)", () => {
      // Also handle standard optional fields (undefined)
      const payload = {
        event: "message_received",
        sender: "+15551234567",
        text: "Hello!",
        protocol: "imessage",
      };

      const result = parseBlooioWebhookEvent(payload);

      expect(result.event).toBe("message_received");
      expect(result.text).toBe("Hello!");
      expect(result.message_id).toBeUndefined();
      expect(result.attachments).toBeUndefined();
    });

    it("should accept event with mixed null and undefined fields", () => {
      const payload = {
        event: "message_received",
        sender: "+15551234567",
        text: null, // explicit null
        protocol: "imessage",
        // message_id is omitted (undefined)
        is_group: false, // explicit value
        received_at: null, // explicit null
      };

      const result = parseBlooioWebhookEvent(payload);

      expect(result.text).toBeNull();
      expect(result.message_id).toBeUndefined();
      expect(result.is_group).toBe(false);
      expect(result.received_at).toBeNull();
    });
  });

  describe("required field validation", () => {
    it("should reject event without required event type", () => {
      const payload = {
        sender: "+15551234567",
        text: "Hello!",
      };

      expect(() => parseBlooioWebhookEvent(payload)).toThrow(ZodError);
    });

    it("should reject event with empty event type", () => {
      const payload = {
        event: "",
        sender: "+15551234567",
      };

      expect(() => parseBlooioWebhookEvent(payload)).toThrow(ZodError);
    });
  });

  describe("attachment validation", () => {
    it("should accept string attachments", () => {
      const payload = {
        event: "message_received",
        sender: "+15551234567",
        attachments: ["https://media.blooio.com/image1.jpg", "https://media.blooio.com/image2.jpg"],
      };

      const result = parseBlooioWebhookEvent(payload);

      expect(result.attachments).toHaveLength(2);
      expect(result.attachments?.[0]).toBe("https://media.blooio.com/image1.jpg");
    });

    it("should accept object attachments with url and name", () => {
      const payload = {
        event: "message_received",
        sender: "+15551234567",
        attachments: [
          { url: "https://media.blooio.com/image.jpg", name: "photo.jpg" },
          { url: "https://media.blooio.com/doc.pdf", name: null }, // name can be null
        ],
      };

      const result = parseBlooioWebhookEvent(payload);

      expect(result.attachments).toHaveLength(2);
      const firstAttachment = result.attachments?.[0] as {
        url: string;
        name?: string | null;
      };
      expect(firstAttachment.url).toBe("https://media.blooio.com/image.jpg");
      expect(firstAttachment.name).toBe("photo.jpg");

      const secondAttachment = result.attachments?.[1] as {
        url: string;
        name?: string | null;
      };
      expect(secondAttachment.name).toBeNull();
    });

    it("should accept null attachments array", () => {
      const payload = {
        event: "message_received",
        sender: "+15551234567",
        attachments: null,
      };

      const result = parseBlooioWebhookEvent(payload);
      expect(result.attachments).toBeNull();
    });
  });

  describe("real Blooio webhook payloads", () => {
    it("should handle typical message_received event", () => {
      // Real-world example from Blooio
      const payload = {
        event: "message_received",
        message_id: "msg_abc123",
        external_id: "+15551234567",
        internal_id: null,
        sender: "+15551234567",
        text: "Hey, can you help me with something?",
        attachments: null,
        protocol: "imessage",
        is_group: false,
        received_at: 1706745600,
        timestamp: 1706745600,
      };

      const result = parseBlooioWebhookEvent(payload);

      expect(result.event).toBe("message_received");
      expect(result.text).toBe("Hey, can you help me with something?");
      expect(result.internal_id).toBeNull();
    });

    it("should handle message with media attachment", () => {
      const payload = {
        event: "message_received",
        message_id: null,
        external_id: "+15559876543",
        internal_id: null,
        sender: "+15559876543",
        text: null, // No text, just media
        attachments: [
          {
            url: "https://backend.blooio.com/media/abc123.heic",
            name: "IMG_1234.HEIC",
          },
        ],
        protocol: "imessage",
        is_group: null,
        received_at: 1706746000,
        timestamp: null,
      };

      const result = parseBlooioWebhookEvent(payload);

      expect(result.text).toBeNull();
      expect(result.attachments).toHaveLength(1);
    });

    it("should handle typing indicator event", () => {
      const payload = {
        event: "typing_started",
        external_id: "+15551234567",
        sender: "+15551234567",
        text: null,
        attachments: null,
        protocol: "imessage",
        is_group: null,
        received_at: null,
        timestamp: 1706746100,
      };

      const result = parseBlooioWebhookEvent(payload);

      expect(result.event).toBe("typing_started");
      expect(result.text).toBeNull();
    });
  });
});
