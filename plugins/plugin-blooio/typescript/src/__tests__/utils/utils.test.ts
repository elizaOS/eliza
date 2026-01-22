import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractAttachmentUrls,
  extractChatIdCandidates,
  getWebhookPath,
  isE164,
  isEmail,
  isGroupId,
  validateChatId,
  verifyWebhookSignature,
} from "../../utils";

describe("Utils", () => {
  describe("identifier helpers", () => {
    it("should validate individual identifiers", () => {
      expect(isE164("+18885551234")).toBe(true);
      expect(isEmail("user@example.com")).toBe(true);
      expect(isGroupId("grp_abc123")).toBe(true);
    });

    it("should validate chat ids", () => {
      expect(validateChatId("+18885551234")).toBe(true);
      expect(validateChatId("user@example.com")).toBe(true);
      expect(validateChatId("grp_abc123")).toBe(true);
      expect(validateChatId("+18885551234,user@example.com")).toBe(true);
      expect(validateChatId("invalid-id")).toBe(false);
    });
  });

  describe("extractChatIdCandidates", () => {
    it("should extract chat id candidates", () => {
      const text = "Message +15551234567 and jane@example.com in grp_abc123";
      const candidates = extractChatIdCandidates(text);
      expect(candidates).toEqual(["+15551234567", "jane@example.com", "grp_abc123"]);
    });
  });

  describe("extractAttachmentUrls", () => {
    it("should extract URLs", () => {
      const urls = extractAttachmentUrls("Check https://example.com/a.png and http://test.com/b");
      expect(urls).toEqual(["https://example.com/a.png", "http://test.com/b"]);
    });
  });

  describe("verifyWebhookSignature", () => {
    it("should validate signatures", () => {
      const secret = "whsec_test";
      const rawBody = JSON.stringify({ event: "message.sent" });
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const payload = `${timestamp}.${rawBody}`;
      const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
      const header = `t=${timestamp},v1=${signature}`;

      expect(verifyWebhookSignature(secret, header, rawBody, 300)).toBe(true);
    });
  });

  describe("getWebhookPath", () => {
    it("should derive path from URL", () => {
      expect(getWebhookPath("https://example.com/webhook")).toBe("/webhook");
    });
  });
});
