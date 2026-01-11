import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_LENGTH, needsSmartSplit, splitMessage } from "../utils";

/**
 * Tests for Discord utility functions.
 * These are pure functions that don't require any external services or mocking.
 */
describe("Discord Utils", () => {
  describe("needsSmartSplit", () => {
    it("should return true for content with code blocks", () => {
      const content = "Some text\n```javascript\ncode here\n```\nmore text";
      expect(needsSmartSplit(content)).toBe(true);
    });

    it("should return true for content with markdown headers", () => {
      const content = "# Header 1\nSome text\n## Header 2\nMore text";
      expect(needsSmartSplit(content)).toBe(true);
    });

    it("should return true for content with numbered lists", () => {
      const content = "1. First item\n2. Second item\n3. Third item";
      expect(needsSmartSplit(content)).toBe(true);
    });

    it("should return true for content with long unbreakable lines", () => {
      const content = "a".repeat(600);
      expect(needsSmartSplit(content)).toBe(true);
    });

    it("should return false for simple text", () => {
      const content = "This is a simple text. It has sentences. But no special formatting.";
      expect(needsSmartSplit(content)).toBe(false);
    });
  });

  describe("splitMessage (fallback)", () => {
    it("should split long content into chunks under max length", () => {
      const longContent = "a".repeat(5000);
      const result = splitMessage(longContent);

      expect(result.length).toBeGreaterThan(1);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
    });

    it("should return single chunk for short content", () => {
      const shortContent = "Short message";
      const result = splitMessage(shortContent);

      expect(result).toEqual([shortContent]);
    });

    it("should preserve line breaks when possible", () => {
      const content = "Line 1\n".repeat(100);
      const result = splitMessage(content);

      expect(result.every((chunk) => chunk.includes("\n") || chunk.length < 10)).toBe(true);
    });

    it("should handle content exactly at max length", () => {
      const content = "a".repeat(MAX_MESSAGE_LENGTH);
      const result = splitMessage(content);

      expect(result).toEqual([content]);
    });

    it("should handle empty content", () => {
      const result = splitMessage("");
      // splitMessage returns empty array for empty input
      expect(result).toEqual([]);
    });

    it("should split on newlines when content has them", () => {
      const lines = Array(50).fill("This is a test line that is reasonably long").join("\n");
      const result = splitMessage(lines);

      // Each chunk should end with content (not be cut mid-line when possible)
      expect(result.length).toBeGreaterThan(1);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
    });
  });

  describe("MAX_MESSAGE_LENGTH constant", () => {
    it("should be set to Discord's safe message limit", () => {
      // Discord allows 2000 chars, but we use 1900 for safety margin
      expect(MAX_MESSAGE_LENGTH).toBe(1900);
    });
  });
});
