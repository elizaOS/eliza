import { describe, expect, it } from "vitest";
import {
  buildChannelLink,
  buildMessageLink,
  chunkDiscordText,
  chunkDiscordTextWithMode,
  escapeDiscordMarkdown,
  extractAllChannelMentions,
  extractAllRoleMentions,
  extractAllUserMentions,
  extractChannelIdFromMention,
  extractRoleIdFromMention,
  extractUserIdFromMention,
  formatDiscordChannelMention,
  formatDiscordRoleMention,
  formatDiscordTimestamp,
  formatDiscordUserMention,
  messageContainsMention,
  parseMessageLink,
  resolveTimestampMs,
  sanitizeThreadName,
  stripDiscordFormatting,
  truncateText,
  truncateUtf16Safe,
} from "../messaging";

/**
 * Tests for Discord messaging utilities
 */
describe("Discord Messaging", () => {
  describe("chunkDiscordText", () => {
    it("should return single chunk for short text", () => {
      const chunks = chunkDiscordText("Hello, world!");
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe("Hello, world!");
    });

    it("should split long text into multiple chunks", () => {
      const longText = "a".repeat(3000);
      const chunks = chunkDiscordText(longText);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    });

    it("should respect custom maxChars", () => {
      const text = "Hello World";
      const chunks = chunkDiscordText(text, { maxChars: 5 });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.length <= 5)).toBe(true);
    });

    it("should handle code blocks", () => {
      const text = "```js\nconst x = 1;\n```";
      const chunks = chunkDiscordText(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it("should split code blocks that exceed limit", () => {
      const longCode = `\`\`\`\n${"a".repeat(2500)}\n\`\`\``;
      const chunks = chunkDiscordText(longCode);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("should handle empty string", () => {
      const chunks = chunkDiscordText("");
      expect(chunks).toHaveLength(0);
    });

    it("should handle text with multiple paragraphs", () => {
      const text = "Paragraph 1\n\nParagraph 2\n\nParagraph 3";
      const chunks = chunkDiscordText(text);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });
  });

  describe("chunkDiscordTextWithMode", () => {
    it("should chunk by newlines when mode is newline", () => {
      const text = "Line 1\nLine 2\nLine 3";
      const chunks = chunkDiscordTextWithMode(text, { chunkMode: "newline", maxLines: 1 });
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("should default to length mode", () => {
      const longText = "a".repeat(3000);
      const chunks = chunkDiscordTextWithMode(longText);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    });
  });

  describe("formatDiscordUserMention", () => {
    it("should format user mention correctly", () => {
      expect(formatDiscordUserMention("123456789")).toBe("<@123456789>");
    });

    it("should handle empty user ID", () => {
      expect(formatDiscordUserMention("")).toBe("<@>");
    });
  });

  describe("formatDiscordChannelMention", () => {
    it("should format channel mention correctly", () => {
      expect(formatDiscordChannelMention("123456789")).toBe("<#123456789>");
    });
  });

  describe("formatDiscordRoleMention", () => {
    it("should format role mention correctly", () => {
      expect(formatDiscordRoleMention("123456789")).toBe("<@&123456789>");
    });
  });

  describe("extractUserIdFromMention", () => {
    it("should extract user ID from mention", () => {
      expect(extractUserIdFromMention("<@123456789>")).toBe("123456789");
    });

    it("should extract user ID from nickname mention", () => {
      expect(extractUserIdFromMention("<@!123456789>")).toBe("123456789");
    });

    it("should return null for invalid mention", () => {
      expect(extractUserIdFromMention("123456789")).toBeNull();
    });

    it("should return null for channel mention", () => {
      expect(extractUserIdFromMention("<#123456789>")).toBeNull();
    });
  });

  describe("extractChannelIdFromMention", () => {
    it("should extract channel ID from mention", () => {
      expect(extractChannelIdFromMention("<#123456789>")).toBe("123456789");
    });

    it("should return null for invalid mention", () => {
      expect(extractChannelIdFromMention("123456789")).toBeNull();
    });

    it("should return null for user mention", () => {
      expect(extractChannelIdFromMention("<@123456789>")).toBeNull();
    });
  });

  describe("extractRoleIdFromMention", () => {
    it("should extract role ID from mention", () => {
      expect(extractRoleIdFromMention("<@&123456789>")).toBe("123456789");
    });

    it("should return null for invalid mention", () => {
      expect(extractRoleIdFromMention("123456789")).toBeNull();
    });
  });

  describe("stripDiscordFormatting", () => {
    it("should strip bold formatting", () => {
      expect(stripDiscordFormatting("**bold**")).toBe("bold");
    });

    it("should strip italic formatting", () => {
      expect(stripDiscordFormatting("*italic*")).toBe("italic");
      // Note: underscore is for underline in Discord, not italic
    });

    it("should strip strikethrough formatting", () => {
      expect(stripDiscordFormatting("~~strikethrough~~")).toBe("strikethrough");
    });

    it("should strip inline code", () => {
      expect(stripDiscordFormatting("`code`")).toBe("code");
    });

    it("should strip code blocks", () => {
      // Code blocks are removed entirely
      expect(stripDiscordFormatting("```\ncode\n```")).toBe("");
    });

    it("should strip spoiler formatting", () => {
      expect(stripDiscordFormatting("||spoiler||")).toBe("spoiler");
    });

    it("should handle mixed formatting", () => {
      const text = "**bold** and *italic* and `code`";
      const stripped = stripDiscordFormatting(text);
      expect(stripped).toBe("bold and italic and code");
    });
  });

  describe("escapeDiscordMarkdown", () => {
    it("should escape asterisks", () => {
      expect(escapeDiscordMarkdown("*text*")).toBe("\\*text\\*");
    });

    it("should escape underscores", () => {
      expect(escapeDiscordMarkdown("_text_")).toBe("\\_text\\_");
    });

    it("should escape tildes", () => {
      expect(escapeDiscordMarkdown("~text~")).toBe("\\~text\\~");
    });

    it("should escape backticks", () => {
      expect(escapeDiscordMarkdown("`code`")).toBe("\\`code\\`");
    });

    it("should escape pipes", () => {
      expect(escapeDiscordMarkdown("|spoiler|")).toBe("\\|spoiler\\|");
    });
  });

  describe("truncateText", () => {
    it("should not truncate short text", () => {
      expect(truncateText("Hello", 10)).toBe("Hello");
    });

    it("should truncate long text", () => {
      expect(truncateText("Hello World", 8)).toBe("Hello W…");
    });

    it("should use custom ellipsis", () => {
      expect(truncateText("Hello World", 9, "...")).toBe("Hello ..."); // or may vary based on implementation
    });

    it("should handle empty string", () => {
      expect(truncateText("", 10)).toBe("");
    });
  });

  describe("truncateUtf16Safe", () => {
    it("should not truncate short text", () => {
      expect(truncateUtf16Safe("Hello", 10)).toBe("Hello");
    });

    it("should truncate long text", () => {
      const result = truncateUtf16Safe("Hello World", 8);
      expect(result.length).toBeLessThanOrEqual(8);
    });

    it("should handle emoji safely", () => {
      // Emoji may take 2 UTF-16 code units
      const text = "Hello 👋 World";
      const result = truncateUtf16Safe(text, 10);
      // Should not cut in the middle of emoji
      expect(result.length).toBeLessThanOrEqual(10);
    });
  });

  describe("messageContainsMention", () => {
    it("should detect user mention", () => {
      expect(messageContainsMention("Hello <@123456789>!", "123456789")).toBe(true);
    });

    it("should detect nickname mention", () => {
      expect(messageContainsMention("Hello <@!123456789>!", "123456789")).toBe(true);
    });

    it("should return false for no mention", () => {
      expect(messageContainsMention("Hello world!", "123456789")).toBe(false);
    });

    it("should return false for different user ID", () => {
      expect(messageContainsMention("Hello <@987654321>!", "123456789")).toBe(false);
    });
  });

  describe("extractAllUserMentions", () => {
    it("should extract all user mentions", () => {
      const text = "Hello <@123> and <@456>!";
      const mentions = extractAllUserMentions(text);
      expect(mentions).toContain("123");
      expect(mentions).toContain("456");
    });

    it("should return empty array for no mentions", () => {
      expect(extractAllUserMentions("Hello world!")).toEqual([]);
    });
  });

  describe("extractAllChannelMentions", () => {
    it("should extract all channel mentions", () => {
      const text = "See <#123> and <#456>!";
      const mentions = extractAllChannelMentions(text);
      expect(mentions).toContain("123");
      expect(mentions).toContain("456");
    });

    it("should return empty array for no mentions", () => {
      expect(extractAllChannelMentions("Hello world!")).toEqual([]);
    });
  });

  describe("extractAllRoleMentions", () => {
    it("should extract all role mentions", () => {
      const text = "Hello <@&123> and <@&456>!";
      const mentions = extractAllRoleMentions(text);
      expect(mentions).toContain("123");
      expect(mentions).toContain("456");
    });

    it("should return empty array for no mentions", () => {
      expect(extractAllRoleMentions("Hello world!")).toEqual([]);
    });
  });

  describe("sanitizeThreadName", () => {
    it("should collapse multiple spaces", () => {
      const result = sanitizeThreadName("Thread    with    spaces");
      expect(result).toBe("Thread with spaces");
    });

    it("should remove newlines", () => {
      const result = sanitizeThreadName("Thread\nwith\nnewlines");
      expect(result).toBe("Thread with newlines");
    });

    it("should truncate to 100 characters", () => {
      const longName = "a".repeat(150);
      const result = sanitizeThreadName(longName);
      expect(result.length).toBeLessThanOrEqual(100);
    });

    it("should trim whitespace", () => {
      expect(sanitizeThreadName("  Thread Name  ")).toBe("Thread Name");
    });
  });

  describe("buildMessageLink", () => {
    it("should build correct message link", () => {
      const link = buildMessageLink("guild123", "channel456", "msg789");
      expect(link).toBe("https://discord.com/channels/guild123/channel456/msg789");
    });
  });

  describe("buildChannelLink", () => {
    it("should build correct channel link", () => {
      const link = buildChannelLink("guild123", "channel456");
      expect(link).toBe("https://discord.com/channels/guild123/channel456");
    });
  });

  describe("parseMessageLink", () => {
    it("should parse valid message link", () => {
      const result = parseMessageLink("https://discord.com/channels/123456789/987654321/111222333");
      expect(result).toEqual({
        guildId: "123456789",
        channelId: "987654321",
        messageId: "111222333",
      });
    });

    it("should return null for invalid link", () => {
      expect(parseMessageLink("https://example.com")).toBeNull();
    });

    it("should return null for channel link without message", () => {
      expect(parseMessageLink("https://discord.com/channels/123456789/987654321")).toBeNull();
    });

    it("should return null for non-numeric IDs", () => {
      expect(parseMessageLink("https://discord.com/channels/abc/def/ghi")).toBeNull();
    });
  });

  describe("formatDiscordTimestamp", () => {
    it("should format timestamp with default style (f)", () => {
      const timestamp = formatDiscordTimestamp(1704067200000); // 2024-01-01 00:00:00 UTC
      expect(timestamp).toBe("<t:1704067200:f>");
    });

    it("should format timestamp with relative style", () => {
      const timestamp = formatDiscordTimestamp(1704067200000, "R");
      expect(timestamp).toBe("<t:1704067200:R>");
    });

    it("should format timestamp with date style", () => {
      const timestamp = formatDiscordTimestamp(1704067200000, "D");
      expect(timestamp).toBe("<t:1704067200:D>");
    });

    it("should accept Date objects", () => {
      const date = new Date(1704067200000);
      const timestamp = formatDiscordTimestamp(date, "t");
      expect(timestamp).toBe("<t:1704067200:t>");
    });
  });

  describe("resolveTimestampMs", () => {
    it("should parse ISO date string", () => {
      const result = resolveTimestampMs("2024-01-01T00:00:00Z");
      expect(result).toBe(1704067200000);
    });

    it("should parse date string without time", () => {
      const result = resolveTimestampMs("2024-01-01");
      // Date.parse interprets date-only strings as UTC
      expect(result).toBe(1704067200000);
    });

    it("should return undefined for invalid date string", () => {
      const result = resolveTimestampMs("not-a-date");
      expect(result).toBeUndefined();
    });

    it("should return undefined for numeric string (not ISO format)", () => {
      // Date.parse doesn't handle plain numeric timestamps
      const result = resolveTimestampMs("1704067200000");
      expect(result).toBeUndefined();
    });

    it("should return undefined for null", () => {
      expect(resolveTimestampMs(null)).toBeUndefined();
    });

    it("should return undefined for empty string", () => {
      expect(resolveTimestampMs("")).toBeUndefined();
    });
  });
});
