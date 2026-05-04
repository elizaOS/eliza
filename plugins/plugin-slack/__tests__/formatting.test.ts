import { describe, expect, it } from "vitest";
import {
  buildSlackMessagePermalink,
  chunkSlackText,
  escapeSlackMrkdwn,
  extractChannelIdFromMention,
  extractUrlFromSlackLink,
  extractUserIdFromMention,
  formatSlackChannel,
  formatSlackChannelMention,
  formatSlackDate,
  formatSlackLink,
  formatSlackSpecialMention,
  formatSlackUserDisplayName,
  formatSlackUserGroupMention,
  formatSlackUserMention,
  getChannelTypeString,
  isDirectMessage,
  isGroupDm,
  isPrivateChannel,
  markdownToSlackMrkdwn,
  markdownToSlackMrkdwnChunks,
  parseSlackMessagePermalink,
  resolveSlackSystemLocation,
  stripSlackFormatting,
  truncateText,
} from "../src/formatting";
import type { SlackChannel, SlackUser } from "../src/types";

/**
 * Tests for Slack formatting utilities
 */
describe("Slack Formatting", () => {
  describe("escapeSlackMrkdwn", () => {
    it("should return unchanged text when no special characters", () => {
      expect(escapeSlackMrkdwn("Hello world")).toBe("Hello world");
    });

    it("should escape ampersands", () => {
      expect(escapeSlackMrkdwn("A & B")).toBe("A &amp; B");
    });

    it("should escape less-than signs", () => {
      expect(escapeSlackMrkdwn("a < b")).toBe("a &lt; b");
    });

    it("should escape greater-than signs", () => {
      expect(escapeSlackMrkdwn("a > b")).toBe("a &gt; b");
    });

    it("should preserve valid Slack user mentions", () => {
      expect(escapeSlackMrkdwn("Hello <@U123ABC>!")).toBe("Hello <@U123ABC>!");
    });

    it("should preserve valid Slack channel mentions", () => {
      expect(escapeSlackMrkdwn("Check <#C123ABC>")).toBe("Check <#C123ABC>");
    });

    it("should preserve valid Slack links", () => {
      expect(escapeSlackMrkdwn("Visit <https://example.com|Link>")).toBe(
        "Visit <https://example.com|Link>",
      );
    });

    it("should preserve valid Slack special mentions", () => {
      expect(escapeSlackMrkdwn("Hey <!here>")).toBe("Hey <!here>");
      expect(escapeSlackMrkdwn("Hey <!channel>")).toBe("Hey <!channel>");
      expect(escapeSlackMrkdwn("Hey <!everyone>")).toBe("Hey <!everyone>");
    });

    it("should escape invalid angle brackets", () => {
      expect(escapeSlackMrkdwn("<invalid>")).toBe("&lt;invalid&gt;");
    });

    it("should handle blockquotes specially", () => {
      expect(escapeSlackMrkdwn("> Quote with & special")).toBe(
        "> Quote with &amp; special",
      );
    });

    it("should handle empty string", () => {
      expect(escapeSlackMrkdwn("")).toBe("");
    });

    it("should handle multiple special characters", () => {
      expect(escapeSlackMrkdwn("a & b < c > d")).toBe(
        "a &amp; b &lt; c &gt; d",
      );
    });
  });

  describe("markdownToSlackMrkdwn", () => {
    it("should return empty string for empty input", () => {
      expect(markdownToSlackMrkdwn("")).toBe("");
    });

    it("should convert bold markdown to Slack bold", () => {
      expect(markdownToSlackMrkdwn("This is **bold** text")).toBe(
        "This is *bold* text",
      );
    });

    it("should convert italic markdown to Slack italic", () => {
      expect(markdownToSlackMrkdwn("This is *italic* text")).toBe(
        "This is _italic_ text",
      );
    });

    it("should convert strikethrough markdown to Slack strikethrough", () => {
      expect(markdownToSlackMrkdwn("This is ~~strikethrough~~ text")).toBe(
        "This is ~strikethrough~ text",
      );
    });

    it("should convert markdown links to Slack links", () => {
      expect(markdownToSlackMrkdwn("Click [here](https://example.com)")).toBe(
        "Click <https://example.com|here>",
      );
    });

    it("should simplify links where text matches URL", () => {
      expect(
        markdownToSlackMrkdwn("[https://example.com](https://example.com)"),
      ).toBe("<https://example.com>");
    });

    it("should convert markdown headers to bold", () => {
      expect(markdownToSlackMrkdwn("# Header 1")).toBe("*Header 1*");
      expect(markdownToSlackMrkdwn("## Header 2")).toBe("*Header 2*");
      expect(markdownToSlackMrkdwn("### Header 3")).toBe("*Header 3*");
    });

    it("should convert code blocks without language hint", () => {
      expect(markdownToSlackMrkdwn("```javascript\ncode\n```")).toBe(
        "```\ncode\n```",
      );
    });

    it("should handle mixed formatting", () => {
      const result = markdownToSlackMrkdwn(
        "**Bold** and *italic* and ~~strike~~ and [link](https://x.com)",
      );
      expect(result).toBe(
        "*Bold* and _italic_ and ~strike~ and <https://x.com|link>",
      );
    });
  });

  describe("chunkSlackText", () => {
    it("should return empty array for empty text", () => {
      expect(chunkSlackText("")).toEqual([]);
    });

    it("should return whitespace text as single chunk", () => {
      expect(chunkSlackText("   ")).toEqual(["   "]);
    });

    it("should return single chunk for short text", () => {
      expect(chunkSlackText("Hello world")).toEqual(["Hello world"]);
    });

    it("should return single chunk for text at max length", () => {
      const text = "a".repeat(4000);
      expect(chunkSlackText(text, 4000)).toEqual([text]);
    });

    it("should split long text into multiple chunks", () => {
      const text = "a".repeat(5000);
      const chunks = chunkSlackText(text, 2000);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    });

    it("should prefer breaking at newlines", () => {
      const text = "Line 1\n".repeat(100);
      const chunks = chunkSlackText(text, 100);
      expect(chunks.length).toBeGreaterThan(1);
    });

    it("should handle code blocks when splitting", () => {
      const codeBlock = `\`\`\`\n${"code line\n".repeat(500)}\`\`\``;
      const chunks = chunkSlackText(codeBlock, 1000);
      // Each chunk should be properly closed/opened
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe("markdownToSlackMrkdwnChunks", () => {
    it("should convert and chunk markdown", () => {
      const markdown = "**Bold** ".repeat(500);
      const chunks = markdownToSlackMrkdwnChunks(markdown, 100);
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.includes("*"))).toBe(true);
    });
  });

  describe("Mention Formatting", () => {
    it("should format user mention correctly", () => {
      expect(formatSlackUserMention("U123ABC")).toBe("<@U123ABC>");
    });

    it("should format channel mention correctly", () => {
      expect(formatSlackChannelMention("C123ABC")).toBe("<#C123ABC>");
    });

    it("should format user group mention correctly", () => {
      expect(formatSlackUserGroupMention("S123ABC")).toBe("<!subteam^S123ABC>");
    });

    it("should format special mentions correctly", () => {
      expect(formatSlackSpecialMention("here")).toBe("<!here>");
      expect(formatSlackSpecialMention("channel")).toBe("<!channel>");
      expect(formatSlackSpecialMention("everyone")).toBe("<!everyone>");
    });
  });

  describe("Link Formatting", () => {
    it("should format simple link", () => {
      expect(formatSlackLink("https://example.com")).toBe(
        "<https://example.com>",
      );
    });

    it("should format link with text", () => {
      expect(formatSlackLink("https://example.com", "Example")).toBe(
        "<https://example.com|Example>",
      );
    });

    it("should not add text when it matches URL", () => {
      expect(
        formatSlackLink("https://example.com", "https://example.com"),
      ).toBe("<https://example.com>");
    });

    it("should escape special characters in link", () => {
      expect(formatSlackLink("https://example.com?a=1&b=2")).toBe(
        "<https://example.com?a=1&amp;b=2>",
      );
    });
  });

  describe("Date Formatting", () => {
    it("should format date with default format", () => {
      const timestamp = 1704067200000; // Jan 1, 2024 00:00:00 UTC
      const result = formatSlackDate(timestamp);
      expect(result).toMatch(/<!date\^\d+\^/);
    });

    it("should format date with custom format", () => {
      const timestamp = new Date("2024-01-01");
      const result = formatSlackDate(timestamp, "{date_long}");
      expect(result).toContain("{date_long}");
    });

    it("should include fallback text", () => {
      const timestamp = 1704067200000;
      const result = formatSlackDate(timestamp, "{date}", "Jan 1, 2024");
      expect(result).toContain("|Jan 1, 2024>");
    });
  });

  describe("Mention Extraction", () => {
    describe("extractUserIdFromMention", () => {
      it("should extract user ID from simple mention", () => {
        expect(extractUserIdFromMention("<@U123ABC>")).toBe("U123ABC");
      });

      it("should extract user ID from mention with display name", () => {
        expect(extractUserIdFromMention("<@U123ABC|john>")).toBe("U123ABC");
      });

      it("should extract W-prefixed user ID", () => {
        expect(extractUserIdFromMention("<@W123ABC>")).toBe("W123ABC");
      });

      it("should return null for invalid mention", () => {
        expect(extractUserIdFromMention("@U123ABC")).toBeNull();
        expect(extractUserIdFromMention("<#C123ABC>")).toBeNull();
        expect(extractUserIdFromMention("U123ABC")).toBeNull();
      });
    });

    describe("extractChannelIdFromMention", () => {
      it("should extract channel ID from mention", () => {
        expect(extractChannelIdFromMention("<#C123ABC>")).toBe("C123ABC");
      });

      it("should extract channel ID with name", () => {
        expect(extractChannelIdFromMention("<#C123ABC|general>")).toBe(
          "C123ABC",
        );
      });

      it("should extract G-prefixed channel ID", () => {
        expect(extractChannelIdFromMention("<#G123ABC>")).toBe("G123ABC");
      });

      it("should extract D-prefixed DM ID", () => {
        expect(extractChannelIdFromMention("<#D123ABC>")).toBe("D123ABC");
      });

      it("should return null for invalid mention", () => {
        expect(extractChannelIdFromMention("#C123ABC")).toBeNull();
        expect(extractChannelIdFromMention("<@U123ABC>")).toBeNull();
      });
    });

    describe("extractUrlFromSlackLink", () => {
      it("should extract URL from simple link", () => {
        expect(extractUrlFromSlackLink("<https://example.com>")).toBe(
          "https://example.com",
        );
      });

      it("should extract URL from link with text", () => {
        expect(
          extractUrlFromSlackLink("<https://example.com|Click here>"),
        ).toBe("https://example.com");
      });

      it("should return null for invalid link", () => {
        expect(extractUrlFromSlackLink("https://example.com")).toBeNull();
        expect(extractUrlFromSlackLink("<@U123>")).toBeNull();
      });
    });
  });

  describe("Channel Type Functions", () => {
    const dmChannel: SlackChannel = {
      id: "D123",
      name: "",
      isIm: true,
      isMpim: false,
      isPrivate: false,
      isGroup: false,
    };

    const groupDmChannel: SlackChannel = {
      id: "G123",
      name: "mpdm-group",
      isIm: false,
      isMpim: true,
      isPrivate: false,
      isGroup: false,
    };

    const privateChannel: SlackChannel = {
      id: "G456",
      name: "private-channel",
      isIm: false,
      isMpim: false,
      isPrivate: true,
      isGroup: true,
    };

    const publicChannel: SlackChannel = {
      id: "C123",
      name: "general",
      isIm: false,
      isMpim: false,
      isPrivate: false,
      isGroup: false,
    };

    describe("isDirectMessage", () => {
      it("should return true for DM", () => {
        expect(isDirectMessage(dmChannel)).toBe(true);
      });

      it("should return false for non-DM", () => {
        expect(isDirectMessage(publicChannel)).toBe(false);
        expect(isDirectMessage(groupDmChannel)).toBe(false);
      });
    });

    describe("isGroupDm", () => {
      it("should return true for group DM", () => {
        expect(isGroupDm(groupDmChannel)).toBe(true);
      });

      it("should return false for non-group DM", () => {
        expect(isGroupDm(dmChannel)).toBe(false);
        expect(isGroupDm(publicChannel)).toBe(false);
      });
    });

    describe("isPrivateChannel", () => {
      it("should return true for private channel", () => {
        expect(isPrivateChannel(privateChannel)).toBe(true);
      });

      it("should return false for public channel", () => {
        expect(isPrivateChannel(publicChannel)).toBe(false);
      });
    });

    describe("getChannelTypeString", () => {
      it("should return correct type strings", () => {
        expect(getChannelTypeString(dmChannel)).toBe("DM");
        expect(getChannelTypeString(groupDmChannel)).toBe("Group DM");
        expect(getChannelTypeString(privateChannel)).toBe("Private Channel");
        expect(getChannelTypeString(publicChannel)).toBe("Channel");
      });
    });

    describe("formatSlackChannel", () => {
      it("should format DM", () => {
        expect(formatSlackChannel(dmChannel)).toBe("Direct Message");
      });

      it("should format group DM with name", () => {
        expect(formatSlackChannel(groupDmChannel)).toBe("Group DM: mpdm-group");
      });

      it("should format channel with # prefix", () => {
        expect(formatSlackChannel(publicChannel)).toBe("#general");
      });
    });
  });

  describe("User Display Name", () => {
    it("should prefer display name", () => {
      const user: SlackUser = {
        id: "U123",
        name: "john",
        profile: {
          displayName: "John Doe",
          realName: "Jonathan Doe",
        },
      };
      expect(formatSlackUserDisplayName(user)).toBe("John Doe");
    });

    it("should fall back to real name", () => {
      const user: SlackUser = {
        id: "U123",
        name: "john",
        profile: {
          displayName: "",
          realName: "Jonathan Doe",
        },
      };
      expect(formatSlackUserDisplayName(user)).toBe("Jonathan Doe");
    });

    it("should fall back to username", () => {
      const user: SlackUser = {
        id: "U123",
        name: "john",
        profile: {
          displayName: "",
          realName: "",
        },
      };
      expect(formatSlackUserDisplayName(user)).toBe("john");
    });
  });

  describe("System Location", () => {
    it("should include team name when provided", () => {
      const channel: SlackChannel = {
        id: "C123",
        name: "general",
        isIm: false,
        isMpim: false,
        isPrivate: false,
        isGroup: false,
      };
      expect(resolveSlackSystemLocation(channel, "Acme Corp")).toBe(
        "Acme Corp - Channel: #general",
      );
    });

    it("should work without team name", () => {
      const channel: SlackChannel = {
        id: "C123",
        name: "general",
        isIm: false,
        isMpim: false,
        isPrivate: false,
        isGroup: false,
      };
      expect(resolveSlackSystemLocation(channel)).toBe("Channel: #general");
    });
  });

  describe("truncateText", () => {
    it("should not truncate short text", () => {
      expect(truncateText("Hello", 10)).toBe("Hello");
    });

    it("should truncate long text with ellipsis", () => {
      expect(truncateText("Hello World", 8)).toBe("Hello W…");
    });

    it("should handle text exactly at max length", () => {
      expect(truncateText("Hello", 5)).toBe("Hello");
    });

    it("should handle very short max length", () => {
      expect(truncateText("Hello", 2)).toBe("H…");
    });
  });

  describe("stripSlackFormatting", () => {
    it("should remove bold formatting", () => {
      expect(stripSlackFormatting("*bold*")).toBe("bold");
    });

    it("should remove italic formatting", () => {
      expect(stripSlackFormatting("_italic_")).toBe("italic");
    });

    it("should remove strikethrough formatting", () => {
      expect(stripSlackFormatting("~strike~")).toBe("strike");
    });

    it("should remove inline code", () => {
      expect(stripSlackFormatting("`code`")).toBe("code");
    });

    it("should remove code blocks", () => {
      expect(stripSlackFormatting("```code```")).toBe("");
      expect(stripSlackFormatting("```\ncode\n```")).toBe("");
    });

    it("should remove user mentions", () => {
      expect(stripSlackFormatting("<@U123>")).toBe("");
      expect(stripSlackFormatting("<@U123|john>")).toBe("");
    });

    it("should remove channel mentions", () => {
      expect(stripSlackFormatting("<#C123>")).toBe("");
      expect(stripSlackFormatting("<#C123|general>")).toBe("");
    });

    it("should extract link text", () => {
      expect(stripSlackFormatting("<https://example.com|Click here>")).toBe(
        "Click here",
      );
    });

    it("should unescape HTML entities", () => {
      expect(stripSlackFormatting("&amp; &lt; &gt;")).toBe("& < >");
    });
  });

  describe("Message Permalink", () => {
    describe("buildSlackMessagePermalink", () => {
      it("should build valid permalink", () => {
        const permalink = buildSlackMessagePermalink(
          "acme",
          "C123ABC",
          "1234567890.123456",
        );
        expect(permalink).toBe(
          "https://acme.slack.com/archives/C123ABC/p1234567890123456",
        );
      });
    });

    describe("parseSlackMessagePermalink", () => {
      it("should parse valid permalink", () => {
        const result = parseSlackMessagePermalink(
          "https://acme.slack.com/archives/C123ABC/p1234567890123456",
        );
        expect(result).toEqual({
          workspaceDomain: "acme",
          channelId: "C123ABC",
          messageTs: "1234567890.123456",
        });
      });

      it("should return null for invalid permalink", () => {
        expect(parseSlackMessagePermalink("https://example.com")).toBeNull();
        expect(parseSlackMessagePermalink("not a url")).toBeNull();
      });

      it("should handle http and https", () => {
        expect(
          parseSlackMessagePermalink(
            "http://acme.slack.com/archives/C123/p1234567890123456",
          ),
        ).not.toBeNull();
      });
    });
  });
});
