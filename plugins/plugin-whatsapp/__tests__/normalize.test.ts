import { describe, expect, it } from "vitest";
import {
  WHATSAPP_TEXT_CHUNK_LIMIT,
  normalizeE164,
  isWhatsAppGroupJid,
  isWhatsAppUserTarget,
  normalizeWhatsAppTarget,
  formatWhatsAppId,
  isWhatsAppGroup,
  getWhatsAppChatType,
  buildWhatsAppUserJid,
  chunkWhatsAppText,
  truncateText,
  resolveWhatsAppSystemLocation,
  isValidWhatsAppNumber,
  formatWhatsAppPhoneNumber,
} from "../src/normalize";

/**
 * Tests for WhatsApp normalization utilities
 */
describe("WhatsApp Normalize", () => {
  describe("normalizeE164", () => {
    it("should return empty string for empty input", () => {
      expect(normalizeE164("")).toBe("");
    });

    it("should preserve E.164 format with +", () => {
      expect(normalizeE164("+1234567890")).toBe("+1234567890");
    });

    it("should remove spaces and dashes", () => {
      expect(normalizeE164("+1 234-567-8901")).toBe("+12345678901");
    });

    it("should remove parentheses and dots", () => {
      expect(normalizeE164("+1 (234) 567.8901")).toBe("+12345678901");
    });

    it("should add + prefix for long numbers", () => {
      expect(normalizeE164("12345678901")).toBe("+12345678901");
    });

    it("should convert 00 prefix to +", () => {
      expect(normalizeE164("0012345678901")).toBe("+12345678901");
    });

    it("should handle short numbers without modification", () => {
      expect(normalizeE164("123456")).toBe("123456");
    });

    it("should remove non-digit characters except +", () => {
      expect(normalizeE164("+1-234-ABC-567")).toBe("+1234567");
    });
  });

  describe("isWhatsAppGroupJid", () => {
    it("should return true for valid group JID", () => {
      expect(isWhatsAppGroupJid("123456789-987654321@g.us")).toBe(true);
    });

    it("should return true for simple group JID", () => {
      expect(isWhatsAppGroupJid("123456789@g.us")).toBe(true);
    });

    it("should return true for group JID with whatsapp: prefix", () => {
      expect(isWhatsAppGroupJid("whatsapp:123456789-987654321@g.us")).toBe(true);
    });

    it("should return false for user JID", () => {
      expect(isWhatsAppGroupJid("41796666864:0@s.whatsapp.net")).toBe(false);
    });

    it("should return false for phone number", () => {
      expect(isWhatsAppGroupJid("+1234567890")).toBe(false);
    });

    it("should return false for invalid group format", () => {
      expect(isWhatsAppGroupJid("invalid@g.us")).toBe(false);
      expect(isWhatsAppGroupJid("123-abc@g.us")).toBe(false);
    });

    it("should be case-insensitive for domain", () => {
      expect(isWhatsAppGroupJid("123456789@G.US")).toBe(true);
    });
  });

  describe("isWhatsAppUserTarget", () => {
    it("should return true for standard user JID", () => {
      expect(isWhatsAppUserTarget("41796666864:0@s.whatsapp.net")).toBe(true);
    });

    it("should return true for user JID without device part", () => {
      expect(isWhatsAppUserTarget("41796666864@s.whatsapp.net")).toBe(true);
    });

    it("should return true for LID", () => {
      expect(isWhatsAppUserTarget("123456@lid")).toBe(true);
    });

    it("should return true with whatsapp: prefix", () => {
      expect(isWhatsAppUserTarget("whatsapp:41796666864:0@s.whatsapp.net")).toBe(true);
    });

    it("should return false for group JID", () => {
      expect(isWhatsAppUserTarget("123456789-987654321@g.us")).toBe(false);
    });

    it("should return false for plain phone number", () => {
      expect(isWhatsAppUserTarget("+1234567890")).toBe(false);
    });
  });

  describe("normalizeWhatsAppTarget", () => {
    it("should return null for empty string", () => {
      expect(normalizeWhatsAppTarget("")).toBeNull();
    });

    it("should return null for whitespace only", () => {
      expect(normalizeWhatsAppTarget("   ")).toBeNull();
    });

    it("should normalize group JID", () => {
      expect(normalizeWhatsAppTarget("123456789-987654321@g.us")).toBe("123456789-987654321@g.us");
    });

    it("should normalize user JID to E.164", () => {
      expect(normalizeWhatsAppTarget("41796666864:0@s.whatsapp.net")).toBe("+41796666864");
    });

    it("should normalize phone number to E.164", () => {
      expect(normalizeWhatsAppTarget("+1-234-567-8901")).toBe("+12345678901");
    });

    it("should strip whatsapp: prefix", () => {
      expect(normalizeWhatsAppTarget("whatsapp:+1234567890")).toBe("+1234567890");
    });

    it("should return null for unknown JID format", () => {
      expect(normalizeWhatsAppTarget("unknown@domain.com")).toBeNull();
    });

    it("should return null for invalid phone number", () => {
      expect(normalizeWhatsAppTarget("abc")).toBeNull();
    });
  });

  describe("formatWhatsAppId", () => {
    it("should format group JID with prefix", () => {
      expect(formatWhatsAppId("123456789-987654321@g.us")).toBe("group:123456789-987654321@g.us");
    });

    it("should format user target as E.164", () => {
      expect(formatWhatsAppId("41796666864:0@s.whatsapp.net")).toBe("+41796666864");
    });

    it("should return original for invalid format", () => {
      expect(formatWhatsAppId("invalid")).toBe("invalid");
    });
  });

  describe("Chat Type Functions", () => {
    describe("isWhatsAppGroup", () => {
      it("should return true for group JID", () => {
        expect(isWhatsAppGroup("123456789-987654321@g.us")).toBe(true);
      });

      it("should return false for user target", () => {
        expect(isWhatsAppGroup("+1234567890")).toBe(false);
      });
    });

    describe("getWhatsAppChatType", () => {
      it("should return group for group JID", () => {
        expect(getWhatsAppChatType("123456789-987654321@g.us")).toBe("group");
      });

      it("should return user for phone number", () => {
        expect(getWhatsAppChatType("+1234567890")).toBe("user");
      });
    });
  });

  describe("buildWhatsAppUserJid", () => {
    it("should build JID from E.164 number", () => {
      expect(buildWhatsAppUserJid("+1234567890")).toBe("1234567890@s.whatsapp.net");
    });

    it("should handle number without +", () => {
      expect(buildWhatsAppUserJid("1234567890")).toBe("1234567890@s.whatsapp.net");
    });

    it("should strip non-digit characters", () => {
      expect(buildWhatsAppUserJid("+1-234-567-8901")).toBe("12345678901@s.whatsapp.net");
    });
  });

  describe("chunkWhatsAppText", () => {
    it("should return empty array for empty text", () => {
      expect(chunkWhatsAppText("")).toEqual([]);
    });

    it("should return empty array for whitespace-only text", () => {
      expect(chunkWhatsAppText("   ")).toEqual([]);
    });

    it("should return single chunk for short text", () => {
      expect(chunkWhatsAppText("Hello world")).toEqual(["Hello world"]);
    });

    it("should use default chunk limit", () => {
      expect(WHATSAPP_TEXT_CHUNK_LIMIT).toBe(4096);
    });

    it("should split long text into chunks", () => {
      const text = "a".repeat(5000);
      const chunks = chunkWhatsAppText(text, { limit: 2000 });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    });

    it("should prefer breaking at paragraph boundaries", () => {
      const text = "Paragraph 1.\n\nParagraph 2.";
      const chunks = chunkWhatsAppText(text, { limit: 20 });
      expect(chunks).toContain("Paragraph 1.");
      expect(chunks).toContain("Paragraph 2.");
    });

    it("should prefer breaking at sentence boundaries", () => {
      const text = "First sentence. Second sentence.";
      const chunks = chunkWhatsAppText(text, { limit: 20 });
      expect(chunks[0]).toMatch(/\.$/);
    });

    it("should trim chunks", () => {
      const text = "Word1\n\nWord2";
      const chunks = chunkWhatsAppText(text, { limit: 10 });
      expect(chunks.every((c) => c === c.trim())).toBe(true);
    });
  });

  describe("truncateText", () => {
    it("should not truncate short text", () => {
      expect(truncateText("Hello", 10)).toBe("Hello");
    });

    it("should truncate long text with ellipsis", () => {
      expect(truncateText("Hello World", 8)).toBe("Hello...");
    });

    it("should handle text exactly at max length", () => {
      expect(truncateText("Hello", 5)).toBe("Hello");
    });

    it("should handle very short max length", () => {
      expect(truncateText("Hello", 3)).toBe("...");
    });

    it("should handle max length of 1", () => {
      expect(truncateText("Hello", 1)).toBe(".");
    });

    it("should handle max length of 2", () => {
      expect(truncateText("Hello", 2)).toBe("..");
    });
  });

  describe("resolveWhatsAppSystemLocation", () => {
    it("should format group chat location", () => {
      expect(
        resolveWhatsAppSystemLocation({
          chatType: "group",
          chatId: "123456789-987654321@g.us",
          chatName: "My Group",
        })
      ).toBe("WhatsApp group:My Group");
    });

    it("should format user chat location", () => {
      expect(
        resolveWhatsAppSystemLocation({
          chatType: "user",
          chatId: "+1234567890",
          chatName: "John Doe",
        })
      ).toBe("WhatsApp user:John Doe");
    });

    it("should use truncated chat ID when no name", () => {
      expect(
        resolveWhatsAppSystemLocation({
          chatType: "user",
          chatId: "12345678901234567890",
        })
      ).toBe("WhatsApp user:12345678");
    });
  });

  describe("isValidWhatsAppNumber", () => {
    it("should return true for valid E.164 number", () => {
      expect(isValidWhatsAppNumber("+12345678901")).toBe(true);
    });

    it("should return true for number that normalizes to valid E.164", () => {
      expect(isValidWhatsAppNumber("12345678901")).toBe(true);
    });

    it("should return false for too short number", () => {
      expect(isValidWhatsAppNumber("+123456")).toBe(false);
    });

    it("should return false for too long number", () => {
      expect(isValidWhatsAppNumber("+1234567890123456")).toBe(false);
    });

    it("should return false for group JID", () => {
      expect(isValidWhatsAppNumber("123456789-987654321@g.us")).toBe(false);
    });

    it("should return false for empty string", () => {
      expect(isValidWhatsAppNumber("")).toBe(false);
    });
  });

  describe("formatWhatsAppPhoneNumber", () => {
    it("should format long number with spaces", () => {
      const result = formatWhatsAppPhoneNumber("+12345678901");
      expect(result).toContain(" ");
    });

    it("should preserve short numbers", () => {
      expect(formatWhatsAppPhoneNumber("+1234567890")).toBe("+1234567890");
    });

    it("should return original for invalid input", () => {
      expect(formatWhatsAppPhoneNumber("abc")).toBe("abc");
    });

    it("should handle numbers with formatting", () => {
      const result = formatWhatsAppPhoneNumber("+1-234-567-8901");
      expect(result).toMatch(/^\+\d/);
    });
  });

  describe("Edge Cases", () => {
    it("should handle JID with multiple device parts", () => {
      // Format: number:device@domain
      expect(normalizeWhatsAppTarget("41796666864:15@s.whatsapp.net")).toBe("+41796666864");
    });

    it("should handle multiple whatsapp: prefixes", () => {
      expect(normalizeWhatsAppTarget("whatsapp:whatsapp:+1234567890")).toBe("+1234567890");
    });

    it("should handle group JID with many segments", () => {
      expect(isWhatsAppGroupJid("1-2-3-4-5@g.us")).toBe(true);
    });

    it("should reject group JID with invalid characters", () => {
      expect(isWhatsAppGroupJid("123-abc-456@g.us")).toBe(false);
    });

    it("should handle LID normalization", () => {
      // LID JIDs with 9 digits get extracted but not normalized (< 10 digits)
      expect(normalizeWhatsAppTarget("123456789@lid")).toBe("123456789");
      // LID JIDs with 10+ digits get E.164 normalized
      expect(normalizeWhatsAppTarget("1234567890@lid")).toBe("+1234567890");
    });
  });
});
