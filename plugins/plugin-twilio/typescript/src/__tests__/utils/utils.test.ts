import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chunkTextForSms,
  convertAudioFormat,
  extractPhoneNumber,
  formatPhoneNumber,
  generateTwiML,
  getWebhookUrl,
  parseMediaFromWebhook,
  validatePhoneNumber,
  validateWebhookSignature,
} from "../../utils";

describe("Utils", () => {
  describe("validatePhoneNumber", () => {
    it("should validate correct E.164 format numbers", () => {
      expect(validatePhoneNumber("+18885551234")).toBe(true);
      expect(validatePhoneNumber("+442071234567")).toBe(true);
      expect(validatePhoneNumber("+1234567890123")).toBe(true);
    });

    it("should reject invalid phone numbers", () => {
      expect(validatePhoneNumber("8885551234")).toBe(false);
      expect(validatePhoneNumber("+0123456789")).toBe(false);
      expect(validatePhoneNumber("++18885551234")).toBe(false);
      expect(validatePhoneNumber("+188855512345678901")).toBe(false);
      expect(validatePhoneNumber("not a number")).toBe(false);
    });
  });

  describe("formatPhoneNumber", () => {
    it("should format US numbers correctly", () => {
      expect(formatPhoneNumber("8885551234")).toBe("+18885551234");
      expect(formatPhoneNumber("18885551234")).toBe("+18885551234");
      expect(formatPhoneNumber("+18885551234")).toBe("+18885551234");
      expect(formatPhoneNumber("(888) 555-1234")).toBe("+18885551234");
    });

    it("should use custom country code", () => {
      expect(formatPhoneNumber("7071234567", "+44")).toBe("+447071234567");
    });

    it("should return null for invalid numbers", () => {
      expect(formatPhoneNumber("123")).toBeNull();
      expect(formatPhoneNumber("")).toBeNull();
    });
  });

  describe("generateTwiML", () => {
    describe("say", () => {
      it("should generate basic say TwiML", () => {
        const twiml = generateTwiML.say("Hello world");
        expect(twiml).toContain('<Say voice="alice">Hello world</Say>');
        expect(twiml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      });

      it("should escape XML characters", () => {
        const twiml = generateTwiML.say("Hello & <world>");
        expect(twiml).toContain("Hello &amp; &lt;world&gt;");
      });

      it("should use custom voice", () => {
        const twiml = generateTwiML.say("Hello", "man");
        expect(twiml).toContain('<Say voice="man">Hello</Say>');
      });
    });

    describe("gather", () => {
      it("should generate gather TwiML with defaults", () => {
        const twiml = generateTwiML.gather("Press 1");
        expect(twiml).toContain('<Gather numDigits="1" timeout="5"');
        expect(twiml).toContain("<Say>Press 1</Say>");
      });

      it("should use custom options", () => {
        const twiml = generateTwiML.gather("Enter PIN", {
          numDigits: 4,
          timeout: 10,
          action: "/process",
          method: "GET",
        });
        expect(twiml).toContain('numDigits="4"');
        expect(twiml).toContain('timeout="10"');
        expect(twiml).toContain('action="/process"');
        expect(twiml).toContain('method="GET"');
      });
    });

    describe("stream", () => {
      it("should generate stream TwiML", () => {
        const twiml = generateTwiML.stream("wss://example.com/stream");
        expect(twiml).toContain('<Stream url="wss://example.com/stream">');
        expect(twiml).toContain("<Start>");
      });

      it("should include custom parameters", () => {
        const twiml = generateTwiML.stream("wss://example.com", {
          callSid: "CA123",
          from: "+18885551234",
        });
        expect(twiml).toContain('<Parameter name="callSid" value="CA123"');
        expect(twiml).toContain('<Parameter name="from" value="+18885551234"');
      });
    });

    describe("record", () => {
      it("should generate record TwiML with defaults", () => {
        const twiml = generateTwiML.record();
        expect(twiml).toContain('<Record maxLength="3600" timeout="5"');
        expect(twiml).toContain('transcribe="false"');
      });

      it("should use custom options", () => {
        const twiml = generateTwiML.record({
          maxLength: 60,
          transcribe: true,
          action: "/recording",
        });
        expect(twiml).toContain('maxLength="60"');
        expect(twiml).toContain('transcribe="true"');
        expect(twiml).toContain('action="/recording"');
      });
    });

    describe("hangup", () => {
      it("should generate hangup TwiML", () => {
        const twiml = generateTwiML.hangup();
        expect(twiml).toContain("<Hangup />");
      });
    });
  });

  describe("parseMediaFromWebhook", () => {
    it("should parse media URLs from webhook data", () => {
      const webhookData = {
        MediaUrl0: "https://example.com/image1.jpg",
        MediaContentType0: "image/jpeg",
        MediaUrl1: "https://example.com/image2.png",
        MediaContentType1: "image/png",
      };

      const media = parseMediaFromWebhook(webhookData, 2);
      expect(media).toHaveLength(2);
      expect(media[0]).toEqual({
        url: "https://example.com/image1.jpg",
        contentType: "image/jpeg",
        sid: "media_0",
      });
      expect(media[1]).toEqual({
        url: "https://example.com/image2.png",
        contentType: "image/png",
        sid: "media_1",
      });
    });

    it("should handle missing content types", () => {
      const webhookData = {
        MediaUrl0: "https://example.com/file",
      };

      const media = parseMediaFromWebhook(webhookData, 1);
      expect(media[0].contentType).toBe("unknown");
    });
  });

  describe("extractPhoneNumber", () => {
    it("should extract E.164 format numbers", () => {
      expect(extractPhoneNumber("Call +18885551234 now")).toBe("+18885551234");
    });

    it("should extract and format US numbers", () => {
      expect(extractPhoneNumber("My number is (888) 555-1234")).toBe("+18885551234");
      expect(extractPhoneNumber("Call 888-555-1234")).toBe("+18885551234");
      expect(extractPhoneNumber("Phone: 8885551234")).toBe("+18885551234");
    });

    it("should return null if no number found", () => {
      expect(extractPhoneNumber("No number here")).toBeNull();
      expect(extractPhoneNumber("")).toBeNull();
    });
  });

  describe("validateWebhookSignature", () => {
    it("should return true (placeholder implementation)", () => {
      // This is a placeholder test since the actual implementation is not complete
      expect(validateWebhookSignature("token", "sig", "url", {})).toBe(true);
    });
  });

  describe("chunkTextForSms", () => {
    it("should not chunk short messages", () => {
      const text = "Hello world";
      const chunks = chunkTextForSms(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it("should chunk long messages at word boundaries", () => {
      const text =
        "a".repeat(50) + " " + "b".repeat(50) + " " + "c".repeat(50) + " " + "d".repeat(50);
      const chunks = chunkTextForSms(text, 160);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(160);
      });
    });

    it("should handle custom max length", () => {
      const text = "word1 word2 word3 word4 word5";
      const chunks = chunkTextForSms(text, 10);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach((chunk) => {
        expect(chunk.length).toBeLessThanOrEqual(10);
      });
    });
  });

  describe("convertAudioFormat", () => {
    it("should return the same buffer (placeholder implementation)", async () => {
      const buffer = Buffer.from("audio data");
      const result = await convertAudioFormat(buffer, "mp3", "wav");
      expect(result).toBe(buffer);
    });
  });

  describe("getWebhookUrl", () => {
    it("should combine base URL and path correctly", () => {
      expect(getWebhookUrl("https://example.com", "/webhook")).toBe("https://example.com/webhook");
      expect(getWebhookUrl("https://example.com/", "/webhook")).toBe("https://example.com/webhook");
      expect(getWebhookUrl("https://example.com", "webhook")).toBe("https://example.com/webhook");
      expect(getWebhookUrl("https://example.com/", "webhook")).toBe("https://example.com/webhook");
    });
  });
});
