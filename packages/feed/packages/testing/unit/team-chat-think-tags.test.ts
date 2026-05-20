/**
 * Think Tag Stripping Unit Tests
 *
 * Tests the logic for stripping `<think>...</think>` reasoning blocks
 * from AI-generated content. This is critical for preventing leakage
 * of internal AI reasoning to users.
 */

import { describe, expect, test } from "bun:test";

/**
 * Replicate the stripThinkTags logic for testing.
 * This matches the implementation in DirectExecutors.ts and MessageBubble.tsx
 */
function stripThinkTags(text: string): string {
  // Remove paired <think>...</think> blocks
  const withoutBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Also strip orphan tags (unclosed/unmatched)
  return withoutBlocks.replace(/<\/?think>/gi, "").trim();
}

describe("stripThinkTags", () => {
  describe("basic functionality", () => {
    test("returns content unchanged when no think tags present", () => {
      const input = "Hello, how can I help you today?";
      expect(stripThinkTags(input)).toBe(input);
    });

    test("removes content wrapped in think tags", () => {
      const input = "<think>I should be helpful</think>Hello!";
      expect(stripThinkTags(input)).toBe("Hello!");
    });

    test("removes only think block, keeps content after", () => {
      const input =
        "<think>Let me analyze this request carefully</think>The answer is 42.";
      expect(stripThinkTags(input)).toBe("The answer is 42.");
    });

    test("handles multiple think blocks", () => {
      const input =
        "<think>First thought</think>Response 1 <think>Second thought</think>Response 2";
      // Note: single space between Response 1 and Response 2 because the space after "1" is preserved
      expect(stripThinkTags(input)).toBe("Response 1 Response 2");
    });

    test("returns empty string when only think tags present", () => {
      const input = "<think>This is all thinking, no response.</think>";
      expect(stripThinkTags(input)).toBe("");
    });
  });

  describe("edge cases", () => {
    test("handles empty string", () => {
      expect(stripThinkTags("")).toBe("");
    });

    test("handles whitespace only", () => {
      expect(stripThinkTags("   \n\t  ")).toBe("");
    });

    test("handles orphan opening tag", () => {
      const input = "<think>This never closes but here is content";
      expect(stripThinkTags(input)).toBe(
        "This never closes but here is content",
      );
    });

    test("handles orphan closing tag", () => {
      const input = "Content here</think>more content";
      expect(stripThinkTags(input)).toBe("Content heremore content");
    });

    test("handles both orphan tags", () => {
      // Note: The regex treats <think>...first </think> as a complete block
      const input = "<think>orphan start and </think>orphan end";
      expect(stripThinkTags(input)).toBe("orphan end");
    });

    test("handles nested think tags (malformed)", () => {
      // The regex removes <think>outer <think>inner</think> first (greedy match to first close)
      // Then orphan </think> is also stripped
      const input =
        "<think>outer <think>inner</think> still outer</think>visible";
      expect(stripThinkTags(input)).toBe("still outervisible");
    });

    test("handles multiline think blocks", () => {
      const input = `<think>
        I need to consider many things:
        1. The user's request
        2. Available information
        3. Best response format
      </think>Here is my response.`;
      expect(stripThinkTags(input)).toBe("Here is my response.");
    });

    test("handles case insensitive tags", () => {
      expect(stripThinkTags("<THINK>Hidden</THINK>Visible")).toBe("Visible");
      expect(stripThinkTags("<Think>Hidden</Think>Visible")).toBe("Visible");
      expect(stripThinkTags("<tHiNk>Hidden</tHiNk>Visible")).toBe("Visible");
    });

    test("preserves content between multiple think blocks", () => {
      const input =
        "<think>A</think>Keep 1<think>B</think>Keep 2<think>C</think>";
      expect(stripThinkTags(input)).toBe("Keep 1Keep 2");
    });

    test("handles think tags with attributes (not stripped - exact match only)", () => {
      // The regex only matches exact <think> tags, not <think attr="...">
      // This is intentional - we only strip standard think blocks
      const input = '<think type="reasoning">Hidden</think>Visible';
      // The closing tag is stripped as orphan, but opening with attributes is preserved
      expect(stripThinkTags(input)).toBe(
        '<think type="reasoning">HiddenVisible',
      );
    });

    test("handles special characters inside think blocks", () => {
      const input =
        "<think>Contains <html> & \"quotes\" 'apostrophes'</think>Clean output";
      expect(stripThinkTags(input)).toBe("Clean output");
    });

    test("handles unicode inside think blocks", () => {
      const input =
        "<think>Thinking in 日本語 and emoji 🤔</think>Response here";
      expect(stripThinkTags(input)).toBe("Response here");
    });

    test("handles very long think blocks", () => {
      const longThinking = "A".repeat(10000);
      const input = `<think>${longThinking}</think>Short response`;
      expect(stripThinkTags(input)).toBe("Short response");
    });

    test("does not match partial tag names", () => {
      // "thinking" should not be treated as a think tag
      const input = "<thinking>Not a think tag</thinking>Content";
      expect(stripThinkTags(input)).toBe(
        "<thinking>Not a think tag</thinking>Content",
      );
    });

    test("handles think tags at end of content", () => {
      const input = "Response first<think>Then thinking</think>";
      expect(stripThinkTags(input)).toBe("Response first");
    });

    test("handles whitespace around think tags", () => {
      const input = "   <think>Hidden</think>   Visible   ";
      expect(stripThinkTags(input)).toBe("Visible");
    });
  });

  describe("security considerations", () => {
    test("does not expose reasoning content", () => {
      const sensitiveReasoning =
        "<think>User seems to be asking about internal API keys. I should not reveal...</think>I can help with general information.";
      const result = stripThinkTags(sensitiveReasoning);
      expect(result).not.toContain("API keys");
      expect(result).not.toContain("internal");
      expect(result).toBe("I can help with general information.");
    });

    test("handles XSS-like content inside think blocks", () => {
      const input = '<think><script>alert("xss")</script></think>Safe content';
      const result = stripThinkTags(input);
      expect(result).not.toContain("script");
      expect(result).toBe("Safe content");
    });
  });
});

describe("getDisplayContent (MessageBubble logic)", () => {
  // This mirrors the frontend display function
  function getDisplayContent(content: string): string {
    const withoutBlocks = content.replace(/<think>[\s\S]*?<\/think>/gi, "");
    return withoutBlocks.replace(/<\/?think>/gi, "").trim();
  }

  test("displays content after think block", () => {
    const input = "<think>Reasoning here</think>User-facing response";
    expect(getDisplayContent(input)).toBe("User-facing response");
  });

  test("returns empty for think-only content", () => {
    const input = "<think>Only reasoning, no response</think>";
    expect(getDisplayContent(input)).toBe("");
  });

  test("handles agent message with complex reasoning", () => {
    const input = `<think>
The user asked about trading strategies. I should:
1. Analyze current market conditions
2. Consider risk factors
3. Provide actionable advice
</think>Based on current market analysis, I recommend a diversified approach focusing on stable assets.`;
    expect(getDisplayContent(input)).toBe(
      "Based on current market analysis, I recommend a diversified approach focusing on stable assets.",
    );
  });
});
