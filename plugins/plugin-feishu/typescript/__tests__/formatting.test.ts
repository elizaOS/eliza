import { describe, expect, it } from "vitest";
import {
  FEISHU_TEXT_CHUNK_LIMIT,
  chunkFeishuText,
  containsMarkdown,
  formatFeishuAtAll,
  formatFeishuUserMention,
  isGroupChat,
  markdownToFeishuChunks,
  markdownToFeishuPost,
  resolveFeishuSystemLocation,
  stripMarkdown,
  truncateText,
} from "../src/formatting";

/**
 * Tests for Feishu formatting utilities
 */
describe("Feishu Formatting", () => {
  describe("Constants", () => {
    it("should have correct text chunk limit", () => {
      expect(FEISHU_TEXT_CHUNK_LIMIT).toBe(4000);
    });
  });

  describe("markdownToFeishuPost", () => {
    it("should handle empty string", () => {
      const result = markdownToFeishuPost("");
      expect(result.zh_cn?.content).toBeDefined();
      expect(result.zh_cn?.content[0][0].tag).toBe("text");
    });

    it("should handle null/undefined", () => {
      const result = markdownToFeishuPost(null as unknown as string);
      expect(result.zh_cn?.content).toBeDefined();
    });

    it("should convert plain text", () => {
      const result = markdownToFeishuPost("Hello world");
      expect(result.zh_cn?.content[0][0]).toEqual({
        tag: "text",
        text: "Hello world",
      });
    });

    it("should convert bold text", () => {
      const result = markdownToFeishuPost("**bold text**");
      expect(result.zh_cn?.content[0]).toContainEqual(
        expect.objectContaining({
          tag: "text",
          text: "bold text",
          style: ["bold"],
        }),
      );
    });

    it("should convert italic text", () => {
      const result = markdownToFeishuPost("*italic text*");
      expect(result.zh_cn?.content[0]).toContainEqual(
        expect.objectContaining({
          tag: "text",
          text: "italic text",
          style: ["italic"],
        }),
      );
    });

    it("should convert strikethrough text", () => {
      const result = markdownToFeishuPost("~~strikethrough~~");
      expect(result.zh_cn?.content[0]).toContainEqual(
        expect.objectContaining({
          tag: "text",
          text: "strikethrough",
          style: ["lineThrough"],
        }),
      );
    });

    it("should convert inline code", () => {
      const result = markdownToFeishuPost("`code`");
      expect(result.zh_cn?.content[0]).toContainEqual(
        expect.objectContaining({ tag: "text", text: "code", style: ["code"] }),
      );
    });

    it("should convert links to anchor elements", () => {
      const result = markdownToFeishuPost("[Click here](https://example.com)");
      expect(result.zh_cn?.content[0]).toContainEqual(
        expect.objectContaining({
          tag: "a",
          text: "Click here",
          href: "https://example.com",
        }),
      );
    });

    it("should handle mixed formatting", () => {
      const result = markdownToFeishuPost("**bold** and *italic* text");
      const elements = result.zh_cn?.content[0] ?? [];
      expect(elements.length).toBeGreaterThan(1);
    });

    it("should convert multiline text", () => {
      const result = markdownToFeishuPost("Line 1\nLine 2\nLine 3");
      expect(result.zh_cn?.content.length).toBe(3);
    });

    it("should remove markdown headers", () => {
      const result = markdownToFeishuPost("# Header\nContent");
      // Headers should be removed, content preserved
      const allText = result.zh_cn?.content
        .flat()
        .filter((e) => e.tag === "text")
        .map((e) => (e as { text: string }).text)
        .join("");
      expect(allText).toContain("Header");
      expect(allText).not.toContain("#");
    });

    it("should convert blockquotes to styled text", () => {
      const result = markdownToFeishuPost("> Quote text");
      const allText = result.zh_cn?.content
        .flat()
        .filter((e) => e.tag === "text")
        .map((e) => (e as { text: string }).text)
        .join("");
      expect(allText).toContain("Quote text");
    });
  });

  describe("chunkFeishuText", () => {
    it("should return empty array for empty text", () => {
      expect(chunkFeishuText("")).toEqual([]);
    });

    it("should return empty array for whitespace-only text", () => {
      expect(chunkFeishuText("   ")).toEqual([]);
    });

    it("should return single chunk for short text", () => {
      expect(chunkFeishuText("Hello world")).toEqual(["Hello world"]);
    });

    it("should use default chunk limit", () => {
      const text = "a".repeat(3999);
      const chunks = chunkFeishuText(text);
      expect(chunks.length).toBe(1);
    });

    it("should split long text into chunks", () => {
      const text = "a".repeat(5000);
      const chunks = chunkFeishuText(text, { limit: 2000 });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((c) => c.length <= 2000)).toBe(true);
    });

    it("should prefer breaking at paragraph boundaries", () => {
      const text = "Paragraph 1 content here.\n\nParagraph 2 content here.";
      const chunks = chunkFeishuText(text, { limit: 30 });
      expect(chunks.some((c) => c.includes("Paragraph 1"))).toBe(true);
    });

    it("should prefer breaking at sentence boundaries", () => {
      const text = "First sentence here. Second sentence here.";
      const chunks = chunkFeishuText(text, { limit: 25 });
      expect(chunks[0]).toMatch(/\.$/);
    });

    it("should trim chunks", () => {
      const text = "Word1\n\nWord2";
      const chunks = chunkFeishuText(text, { limit: 10 });
      expect(chunks.every((c) => c === c.trim())).toBe(true);
    });

    it("should filter out empty chunks", () => {
      const text = "a\n\n\nb";
      const chunks = chunkFeishuText(text, { limit: 10 });
      expect(chunks.every((c) => c.length > 0)).toBe(true);
    });
  });

  describe("markdownToFeishuChunks", () => {
    it("should return chunks with post and text", () => {
      const chunks = markdownToFeishuChunks("**Bold** text");
      expect(chunks.length).toBe(1);
      expect(chunks[0].post).toBeDefined();
      expect(chunks[0].text).toBeDefined();
    });

    it("should handle long markdown", () => {
      const markdown = "**Bold** ".repeat(500);
      const chunks = markdownToFeishuChunks(markdown, 100);
      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  describe("containsMarkdown", () => {
    it("should return false for empty string", () => {
      expect(containsMarkdown("")).toBe(false);
    });

    it("should return false for plain text", () => {
      expect(containsMarkdown("Hello world")).toBe(false);
    });

    it("should return true for bold text", () => {
      expect(containsMarkdown("**bold**")).toBe(true);
    });

    it("should return true for italic text", () => {
      expect(containsMarkdown("*italic*")).toBe(true);
    });

    it("should return true for strikethrough", () => {
      expect(containsMarkdown("~~strike~~")).toBe(true);
    });

    it("should return true for inline code", () => {
      expect(containsMarkdown("`code`")).toBe(true);
    });

    it("should return true for code blocks", () => {
      expect(containsMarkdown("```code```")).toBe(true);
    });

    it("should return true for links", () => {
      expect(containsMarkdown("[link](url)")).toBe(true);
    });

    it("should return true for headers", () => {
      expect(containsMarkdown("# Header")).toBe(true);
    });

    it("should return true for unordered lists", () => {
      expect(containsMarkdown("- item")).toBe(true);
      expect(containsMarkdown("* item")).toBe(true);
    });

    it("should return true for ordered lists", () => {
      expect(containsMarkdown("1. item")).toBe(true);
    });
  });

  describe("stripMarkdown", () => {
    it("should return plain text unchanged", () => {
      expect(stripMarkdown("Hello world")).toBe("Hello world");
    });

    it("should remove bold markers", () => {
      expect(stripMarkdown("**bold**")).toBe("bold");
      expect(stripMarkdown("__bold__")).toBe("bold");
    });

    it("should remove italic markers", () => {
      expect(stripMarkdown("*italic*")).toBe("italic");
      expect(stripMarkdown("_italic_")).toBe("italic");
    });

    it("should remove strikethrough markers", () => {
      expect(stripMarkdown("~~strike~~")).toBe("strike");
    });

    it("should remove headers", () => {
      expect(stripMarkdown("# Header")).toBe("Header");
      expect(stripMarkdown("## Header 2")).toBe("Header 2");
    });

    it("should remove blockquotes", () => {
      expect(stripMarkdown("> Quote")).toBe("Quote");
    });

    it("should remove code blocks but keep content", () => {
      // Multi-line code blocks preserve the content (trailing newlines are cleaned up)
      expect(stripMarkdown("```\ncode here\n```")).toBe("code here");
      // Code blocks with language hint preserve content after the newline
      expect(stripMarkdown("```js\ncode here\n```")).toBe("code here");
    });

    it("should remove inline code markers", () => {
      expect(stripMarkdown("`code`")).toBe("code");
    });

    it("should extract link text", () => {
      expect(stripMarkdown("[Click here](https://example.com)")).toBe(
        "Click here",
      );
    });

    it("should handle mixed formatting", () => {
      expect(stripMarkdown("**Bold** and *italic*")).toBe("Bold and italic");
    });

    it("should clean up excessive newlines", () => {
      expect(stripMarkdown("Line 1\n\n\n\nLine 2")).toBe("Line 1\n\nLine 2");
    });
  });

  describe("Mention Formatting", () => {
    describe("formatFeishuUserMention", () => {
      it("should format user mention correctly", () => {
        expect(formatFeishuUserMention("ou_123456")).toBe(
          '<at user_id="ou_123456"></at>',
        );
      });
    });

    describe("formatFeishuAtAll", () => {
      it("should format @all mention correctly", () => {
        expect(formatFeishuAtAll()).toBe('<at user_id="all"></at>');
      });
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

  describe("resolveFeishuSystemLocation", () => {
    it("should format p2p chat location", () => {
      expect(
        resolveFeishuSystemLocation({
          chatType: "p2p",
          chatId: "oc_abcd1234",
          chatName: "John Doe",
        }),
      ).toBe("Feishu p2p:John Doe");
    });

    it("should format group chat location", () => {
      expect(
        resolveFeishuSystemLocation({
          chatType: "group",
          chatId: "oc_abcd1234",
          chatName: "Team Chat",
        }),
      ).toBe("Feishu group:Team Chat");
    });

    it("should use truncated chat ID when no name", () => {
      expect(
        resolveFeishuSystemLocation({
          chatType: "group",
          chatId: "oc_abcdefgh12345678",
        }),
      ).toBe("Feishu group:oc_abcde");
    });
  });

  describe("isGroupChat", () => {
    it("should return true for group chat type", () => {
      expect(isGroupChat("group")).toBe(true);
    });

    it("should return false for p2p chat type", () => {
      expect(isGroupChat("p2p")).toBe(false);
    });

    it("should return false for other chat types", () => {
      expect(isGroupChat("unknown")).toBe(false);
    });
  });

  describe("Edge Cases", () => {
    it("should handle code blocks with language hint", () => {
      const result = markdownToFeishuPost("```javascript\nconst x = 1;\n```");
      expect(result.zh_cn?.content).toBeDefined();
    });

    it("should handle nested formatting", () => {
      // Note: nested formatting behavior depends on implementation
      const result = markdownToFeishuPost("**bold with *italic* inside**");
      expect(result.zh_cn?.content).toBeDefined();
    });

    it("should handle links with special characters", () => {
      const result = markdownToFeishuPost(
        "[Link](https://example.com?a=1&b=2)",
      );
      const anchor = result.zh_cn?.content[0]?.find((e) => e.tag === "a");
      expect(anchor).toBeDefined();
    });

    it("should handle emoji in text", () => {
      const result = markdownToFeishuPost("Hello 👋 World 🌍");
      const text = result.zh_cn?.content[0]?.find((e) => e.tag === "text");
      expect((text as { text: string })?.text).toContain("👋");
    });

    it("should handle very long single lines", () => {
      const longLine = "a".repeat(5000);
      const chunks = chunkFeishuText(longLine, { limit: 1000 });
      expect(chunks.length).toBe(5);
      expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    });
  });
});
