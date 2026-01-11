import type { IAgentRuntime } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MESSAGE_LENGTH, needsSmartSplit, smartSplitMessage, splitMessage } from "../src/utils";

interface MockLogger {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

describe("Discord Utils - Smart Split Message", () => {
  let mockRuntime: IAgentRuntime;
  let mockLogger: MockLogger;

  beforeEach(() => {
    mockLogger = {
      debug: vi.fn(() => {}),
      info: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
    };

    mockRuntime = {
      useModel: vi.fn(async () => ""),
      logger: mockLogger,
    } as unknown as IAgentRuntime;
  });

  describe("parseJSONArrayFromText (via smartSplitMessage)", () => {
    it("should successfully parse JSON array from LLM response", async () => {
      const longContent = "a".repeat(3000);
      const expectedChunks = ["chunk1", "chunk2", "chunk3"];

      // Mock LLM to return a valid JSON array
      mockRuntime.useModel = vi.fn(async () => JSON.stringify(expectedChunks));

      const result = await smartSplitMessage(mockRuntime, longContent);

      expect(result).toEqual(expectedChunks);
      expect(mockRuntime.useModel).toHaveBeenCalledWith(
        ModelType.TEXT_SMALL,
        expect.objectContaining({ prompt: expect.any(String) })
      );
    });

    it("should parse JSON array wrapped in code blocks", async () => {
      const longContent = "a".repeat(3000);
      const expectedChunks = ["chunk1", "chunk2"];

      // Mock LLM to return JSON array in code block
      const llmResponse = `\`\`\`json\n${JSON.stringify(expectedChunks)}\n\`\`\``;
      mockRuntime.useModel = vi.fn(async () => llmResponse);

      const result = await smartSplitMessage(mockRuntime, longContent);

      expect(result).toEqual(expectedChunks);
    });

    it("should parse JSON array with extra text around it", async () => {
      const longContent = "a".repeat(3000);
      const expectedChunks = ["chunk1", "chunk2"];

      // Mock LLM to return JSON array with markdown code block
      const llmResponse = `Here are the chunks:\n\`\`\`json\n${JSON.stringify(expectedChunks)}\n\`\`\`\nDone!`;
      mockRuntime.useModel = vi.fn(async () => llmResponse);

      const result = await smartSplitMessage(mockRuntime, longContent);

      expect(result).toEqual(expectedChunks);
    });

    it("should validate chunk lengths and fallback if too long", async () => {
      const longContent = "a".repeat(3000);
      const tooLongChunks = ["a".repeat(MAX_MESSAGE_LENGTH + 100)];

      // Mock LLM to return chunks that are too long
      mockRuntime.useModel = vi.fn(async () => JSON.stringify(tooLongChunks));

      const result = await smartSplitMessage(mockRuntime, longContent);

      // Should fall back to simple split
      expect(result).not.toEqual(tooLongChunks);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
    });

    it("should fallback to simple split when LLM returns invalid JSON", async () => {
      const longContent = "a".repeat(3000);

      // Mock LLM to return invalid JSON
      mockRuntime.useModel = vi.fn(async () => "This is not valid JSON");

      const result = await smartSplitMessage(mockRuntime, longContent);

      // Should fall back to simple split
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
      // Debug logging should have been called (either for smart split attempt or fallback)
      expect(mockLogger.debug).toHaveBeenCalled();
    });

    it("should fallback to simple split when LLM returns object instead of array", async () => {
      const longContent = "a".repeat(3000);

      // Mock LLM to return a JSON object (wrong type)
      mockRuntime.useModel = vi.fn(async () => '{"chunk": "value"}');

      const result = await smartSplitMessage(mockRuntime, longContent);

      // Should fall back to simple split
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
    });

    it("should fallback to simple split when LLM returns empty array", async () => {
      const longContent = "a".repeat(3000);

      // Mock LLM to return empty array
      mockRuntime.useModel = vi.fn(async () => "[]");

      const result = await smartSplitMessage(mockRuntime, longContent);

      // Should fall back to simple split
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
    });

    it("should fallback when array contains non-string values", async () => {
      const longContent = "a".repeat(3000);

      // Mock LLM to return array with non-string values
      mockRuntime.useModel = vi.fn(async () => "[123, true, null]");

      const result = await smartSplitMessage(mockRuntime, longContent);

      // Should fall back to simple split
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => typeof chunk === "string")).toBe(true);
    });

    it("should return single chunk when content fits in one message", async () => {
      const shortContent = "Short message";

      const result = await smartSplitMessage(mockRuntime, shortContent);

      expect(result).toEqual([shortContent]);
      // Should not call LLM for short content
      expect(mockRuntime.useModel).not.toHaveBeenCalled();
    });

    it("should handle LLM errors gracefully", async () => {
      const longContent = "a".repeat(3000);

      // Mock LLM to throw an error
      mockRuntime.useModel = vi.fn(async () => {
        throw new Error("LLM error");
      });

      const result = await smartSplitMessage(mockRuntime, longContent);

      // Should fall back to simple split
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining("Smart split failed"));
    });
  });

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
  });

  describe("Integration: smartSplitMessage with realistic content", () => {
    it("should handle code-heavy content correctly", async () => {
      const codeContent = `
Here's a Python example:
\`\`\`python
def hello_world():
    print("Hello, world!")
    for i in range(100):
        print(i)
\`\`\`

And here's another example:
\`\`\`javascript
function test() {
  console.log("test");
}
\`\`\`
`.repeat(5);

      // Create valid chunks under the length limit
      const chunk1 = codeContent.slice(0, 1500);
      const chunk2 = codeContent.slice(1500);
      const expectedChunks = [chunk1, chunk2].filter((c) => c.length > 0);
      mockRuntime.useModel = vi.fn(async () => JSON.stringify(expectedChunks));

      const result = await smartSplitMessage(mockRuntime, codeContent);

      // Verify the result matches what the LLM returned and all chunks are valid
      expect(result).toEqual(expectedChunks);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
      expect(result.every((chunk) => typeof chunk === "string" && chunk.length > 0)).toBe(true);
    });

    it("should handle markdown lists correctly", async () => {
      const listContent = `
# My List
1. First item with lots of text to make it longer
2. Second item with lots of text to make it longer
3. Third item with lots of text to make it longer
`.repeat(20);

      const expectedChunks = [listContent.slice(0, 1500), listContent.slice(1500)];
      mockRuntime.useModel = vi.fn(async () => JSON.stringify(expectedChunks));

      const result = await smartSplitMessage(mockRuntime, listContent);

      expect(result).toEqual(expectedChunks);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
    });
  });
});
