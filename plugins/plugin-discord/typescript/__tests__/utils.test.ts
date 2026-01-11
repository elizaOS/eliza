import type { IAgentRuntime, IDatabaseAdapter, UUID } from "@elizaos/core";
import { ModelType, logger } from "@elizaos/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MESSAGE_LENGTH, needsSmartSplit, smartSplitMessage, splitMessage } from "../src/utils";

// Import the real runtime
import { AgentRuntime } from "@elizaos/core";

// We need a database adapter for tests - use PGLite
let sqlPlugin: { createDatabaseAdapter: (config: { dataDir: string }, agentId: UUID) => IDatabaseAdapter };

beforeAll(async () => {
  try {
    sqlPlugin = await import("@elizaos/plugin-sql");
  } catch {
    console.warn("@elizaos/plugin-sql not available, some tests will be skipped");
  }
});

// Helper to create a UUID
function createUUID(): UUID {
  return crypto.randomUUID() as UUID;
}

/**
 * Helper to create a real test runtime with PGLite database
 */
async function createTestRuntime(): Promise<{ runtime: IAgentRuntime; cleanup: () => Promise<void> }> {
  if (!sqlPlugin) {
    throw new Error("@elizaos/plugin-sql is required for these tests");
  }

  const agentId = createUUID();
  const adapter = sqlPlugin.createDatabaseAdapter({ dataDir: ":memory:" }, agentId);
  await adapter.init();

  const runtime = new AgentRuntime({
    agentId,
    character: {
      name: "Test Agent",
      bio: "A test agent for discord utils tests",
      system: "You are a helpful test assistant.",
      plugins: [],
      settings: {},
    },
    adapter,
  });

  await runtime.initialize();

  return {
    runtime,
    cleanup: async () => {
      await runtime.stop();
      await adapter.close();
    },
  };
}

describe("Discord Utils - Smart Split Message", () => {
  let runtime: IAgentRuntime;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    if (sqlPlugin) {
      const result = await createTestRuntime();
      runtime = result.runtime;
      cleanup = result.cleanup;
    }
    
    vi.spyOn(logger, "debug").mockImplementation(() => {});
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (cleanup) {
      await cleanup();
    }
  });

  describe("parseJSONArrayFromText (via smartSplitMessage)", () => {
    it("should successfully parse JSON array from LLM response", async () => {
      if (!sqlPlugin) {
        console.warn("Skipping test - plugin-sql not available");
        return;
      }

      const longContent = "a".repeat(3000);
      const expectedChunks = ["chunk1", "chunk2", "chunk3"];

      // Spy on useModel to return a valid JSON array
      vi.spyOn(runtime, "useModel").mockResolvedValue(JSON.stringify(expectedChunks));

      const result = await smartSplitMessage(runtime, longContent);

      expect(result).toEqual(expectedChunks);
      expect(runtime.useModel).toHaveBeenCalledWith(
        ModelType.TEXT_SMALL,
        expect.objectContaining({ prompt: expect.any(String) })
      );
    });

    it("should parse JSON array wrapped in code blocks", async () => {
      if (!sqlPlugin) {
        console.warn("Skipping test - plugin-sql not available");
        return;
      }

      const longContent = "a".repeat(3000);
      const expectedChunks = ["chunk1", "chunk2"];

      // Spy on useModel to return JSON array in code block
      const llmResponse = `\`\`\`json\n${JSON.stringify(expectedChunks)}\n\`\`\``;
      vi.spyOn(runtime, "useModel").mockResolvedValue(llmResponse);

      const result = await smartSplitMessage(runtime, longContent);

      expect(result).toEqual(expectedChunks);
    });

    it("should parse JSON array with extra text around it", async () => {
      if (!sqlPlugin) {
        console.warn("Skipping test - plugin-sql not available");
        return;
      }

      const longContent = "a".repeat(3000);
      const expectedChunks = ["chunk1", "chunk2"];

      // Spy on useModel to return JSON array with markdown code block
      const llmResponse = `Here are the chunks:\n\`\`\`json\n${JSON.stringify(expectedChunks)}\n\`\`\`\nDone!`;
      vi.spyOn(runtime, "useModel").mockResolvedValue(llmResponse);

      const result = await smartSplitMessage(runtime, longContent);

      expect(result).toEqual(expectedChunks);
    });

    it("should validate chunk lengths and fallback if too long", async () => {
      if (!sqlPlugin) {
        console.warn("Skipping test - plugin-sql not available");
        return;
      }

      const longContent = "a".repeat(3000);
      const tooLongChunks = ["a".repeat(MAX_MESSAGE_LENGTH + 100)];

      // Spy on useModel to return chunks that are too long
      vi.spyOn(runtime, "useModel").mockResolvedValue(JSON.stringify(tooLongChunks));

      const result = await smartSplitMessage(runtime, longContent);

      // Should fall back to simple split
      expect(result).not.toEqual(tooLongChunks);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
    });

    it("should fallback to simple split when LLM returns invalid JSON", async () => {
      if (!sqlPlugin) {
        console.warn("Skipping test - plugin-sql not available");
        return;
      }

      const longContent = "a".repeat(3000);

      // Spy on useModel to return invalid JSON
      vi.spyOn(runtime, "useModel").mockResolvedValue("This is not valid JSON");

      const result = await smartSplitMessage(runtime, longContent);

      // Should fall back to simple split
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
    });

    it("should fallback to simple split when LLM returns object instead of array", async () => {
      if (!sqlPlugin) {
        console.warn("Skipping test - plugin-sql not available");
        return;
      }

      const longContent = "a".repeat(3000);

      // Spy on useModel to return a JSON object (wrong type)
      vi.spyOn(runtime, "useModel").mockResolvedValue('{"chunk": "value"}');

      const result = await smartSplitMessage(runtime, longContent);

      // Should fall back to simple split
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
    });

    it("should fallback to simple split when LLM returns empty array", async () => {
      if (!sqlPlugin) {
        console.warn("Skipping test - plugin-sql not available");
        return;
      }

      const longContent = "a".repeat(3000);

      // Spy on useModel to return empty array
      vi.spyOn(runtime, "useModel").mockResolvedValue("[]");

      const result = await smartSplitMessage(runtime, longContent);

      // Should fall back to simple split
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
    });

    it("should fallback when array contains non-string values", async () => {
      if (!sqlPlugin) {
        console.warn("Skipping test - plugin-sql not available");
        return;
      }

      const longContent = "a".repeat(3000);

      // Spy on useModel to return array with non-string values
      vi.spyOn(runtime, "useModel").mockResolvedValue("[123, true, null]");

      const result = await smartSplitMessage(runtime, longContent);

      // Should fall back to simple split
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => typeof chunk === "string")).toBe(true);
    });

    it("should return single chunk when content fits in one message", async () => {
      if (!sqlPlugin) {
        console.warn("Skipping test - plugin-sql not available");
        return;
      }

      const shortContent = "Short message";

      vi.spyOn(runtime, "useModel");

      const result = await smartSplitMessage(runtime, shortContent);

      expect(result).toEqual([shortContent]);
      // Should not call LLM for short content
      expect(runtime.useModel).not.toHaveBeenCalled();
    });

    it("should handle LLM errors gracefully", async () => {
      if (!sqlPlugin) {
        console.warn("Skipping test - plugin-sql not available");
        return;
      }

      const longContent = "a".repeat(3000);

      // Spy on useModel to throw an error
      vi.spyOn(runtime, "useModel").mockRejectedValue(new Error("LLM error"));

      const result = await smartSplitMessage(runtime, longContent);

      // Should fall back to simple split
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
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
      if (!sqlPlugin) {
        console.warn("Skipping test - plugin-sql not available");
        return;
      }

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
      vi.spyOn(runtime, "useModel").mockResolvedValue(JSON.stringify(expectedChunks));

      const result = await smartSplitMessage(runtime, codeContent);

      // Verify the result matches what the LLM returned and all chunks are valid
      expect(result).toEqual(expectedChunks);
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
      expect(result.every((chunk) => typeof chunk === "string" && chunk.length > 0)).toBe(true);
    });

    it("should handle markdown lists correctly", async () => {
      if (!sqlPlugin) {
        console.warn("Skipping test - plugin-sql not available");
        return;
      }

      const listContent = `
# My List
1. First item with lots of text to make it longer
2. Second item with lots of text to make it longer
3. Third item with lots of text to make it longer
`.repeat(20);

      const expectedChunks = [listContent.slice(0, 1500), listContent.slice(1500)];
      vi.spyOn(runtime, "useModel").mockResolvedValue(JSON.stringify(expectedChunks));

      const result = await smartSplitMessage(runtime, listContent);

      expect(result).toEqual(expectedChunks);
      expect(result.every((chunk) => chunk.length <= MAX_MESSAGE_LENGTH)).toBe(true);
    });
  });
});
