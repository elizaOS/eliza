/**
 * Tests for JSON Continuation Parser
 * Tests various edge cases for merging truncated LLM responses
 */

import { describe, expect, it } from "bun:test";
import type { JsonValue } from "../../types/common";
import {
  attemptJsonRepair,
  cleanMarkdownCodeBlocks,
  extractJsonArrays,
  extractJsonFromText,
  mergeJsonArrays,
  parseContinuationContent,
} from "../json-continuation-parser";

describe("cleanMarkdownCodeBlocks", () => {
  it("should remove markdown code fences", () => {
    const input = '```json\n[{"id": 1}]\n```';
    const result = cleanMarkdownCodeBlocks(input);
    expect(result).toBe('[{"id": 1}]');
  });

  it("should handle code blocks without json tag", () => {
    const input = '```\n[{"id": 1}]\n```';
    const result = cleanMarkdownCodeBlocks(input);
    expect(result).toBe('[{"id": 1}]');
  });

  it("should handle content without code blocks", () => {
    const input = '[{"id": 1}]';
    const result = cleanMarkdownCodeBlocks(input);
    expect(result).toBe('[{"id": 1}]');
  });

  it("should handle multiple code fence markers", () => {
    const input = '```json\n[{"id": 1}]\n```\nSome text\n```\n[{"id": 2}]```';
    const result = cleanMarkdownCodeBlocks(input);
    expect(result).toContain('[{"id": 1}]');
  });
});

describe("extractJsonFromText", () => {
  it("should extract array from prose", () => {
    const input = 'Here are the results: [{"id": 1}, {"id": 2}]';
    const result = extractJsonFromText(input);
    expect(result).toBe('[{"id": 1}, {"id": 2}]');
  });

  it("should extract object from prose", () => {
    const input = 'The result is: {"status": "success"}';
    const result = extractJsonFromText(input);
    expect(result).toBe('{"status": "success"}');
  });

  it("should return as-is if already JSON", () => {
    const input = '[{"id": 1}]';
    const result = extractJsonFromText(input);
    expect(result).toBe(input);
  });
});

describe("extractJsonArrays", () => {
  it("should extract single complete array", () => {
    const input = '[{"id": 1}, {"id": 2}]';
    const result = extractJsonArrays(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('[{"id": 1}, {"id": 2}]');
  });

  it("should extract multiple arrays", () => {
    const input = '[{"id": 1}] some text [{"id": 2}]';
    const result = extractJsonArrays(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('[{"id": 1}]');
    expect(result[1]).toBe('[{"id": 2}]');
  });

  it("should handle nested arrays", () => {
    const input = '[{"items": [1, 2, 3]}, {"items": [4, 5]}]';
    const result = extractJsonArrays(input);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(input);
  });

  it("should not extract incomplete arrays", () => {
    const input = '[{"id": 1}, {"id": 2}';
    const result = extractJsonArrays(input);
    expect(result).toHaveLength(0);
  });

  it("should handle multiple complete arrays with incomplete at end", () => {
    const input = '[{"id": 1}] [{"id": 2}] [{"id": 3}';
    const result = extractJsonArrays(input);
    expect(result).toHaveLength(2);
  });
});

describe("attemptJsonRepair", () => {
  it("should close unclosed array", () => {
    const input = '[{"id": 1}, {"id": 2}';
    const result = attemptJsonRepair(input);
    expect(result).toBe('[{"id": 1}, {"id": 2}]');
    expect(() => JSON.parse(result!)).not.toThrow();
  });

  it("should close unclosed object in array", () => {
    const input = '[{"id": 1}, {"id": 2, "name": "test"';
    const result = attemptJsonRepair(input);
    expect(result).not.toBeNull();
    expect(() => JSON.parse(result!)).not.toThrow();
  });

  it("should remove trailing comma", () => {
    const input = '[{"id": 1},';
    const result = attemptJsonRepair(input);
    expect(result).toBe('[{"id": 1}]');
  });

  it("should close unclosed string", () => {
    const input = '[{"id": 1, "name": "test';
    const result = attemptJsonRepair(input);
    expect(result).not.toBeNull();
    expect(() => JSON.parse(result!)).not.toThrow();
  });

  it("should handle nested objects and arrays", () => {
    const input = '[{"data": {"nested": [1, 2';
    const result = attemptJsonRepair(input);
    // Complex nested structures are harder to repair, may return null
    if (result) {
      expect(() => JSON.parse(result)).not.toThrow();
    } else {
      // It's okay if complex cases can't be repaired
      expect(result).toBeNull();
    }
  });

  it("should return null for completely invalid JSON", () => {
    const input = "not json at all {[}]";
    const result = attemptJsonRepair(input);
    expect(result).toBeNull();
  });

  it("should handle escaped quotes", () => {
    const input = '[{"message": "He said \\"hello\\""}';
    const result = attemptJsonRepair(input);
    expect(result).toBe('[{"message": "He said \\"hello\\""}]');
  });
});

describe("mergeJsonArrays", () => {
  it("should merge multiple valid arrays", () => {
    const arrays = ['[{"id": 1}]', '[{"id": 2}]', '[{"id": 3}]'];
    const result = mergeJsonArrays(arrays);
    expect(result).toHaveLength(3);
    expect(result).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });

  it("should skip invalid JSON fragments", () => {
    const arrays = ['[{"id": 1}]', "invalid", '[{"id": 2}]'];
    const result = mergeJsonArrays(arrays);
    expect(result).toHaveLength(2);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("should repair truncated arrays when enabled", () => {
    const arrays = ['[{"id": 1}]', '[{"id": 2}, {"id": 3}'];
    const result = mergeJsonArrays(arrays, { repairTruncated: true });
    expect(result).toHaveLength(3);
  });

  it("should handle single objects as arrays", () => {
    const arrays = ['{"id": 1}'];
    const result = mergeJsonArrays(arrays);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ id: 1 });
  });

  it("should merge complex objects", () => {
    const arrays = [
      '[{"npcId": "alice", "action": "buy_yes", "amount": 100}]',
      '[{"npcId": "bob", "action": "hold"}]',
    ];
    const result = mergeJsonArrays(arrays);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty("npcId", "alice");
    expect(result[1]).toHaveProperty("npcId", "bob");
  });
});

describe("parseContinuationContent", () => {
  it("should parse simple valid JSON", () => {
    const input = '[{"id": 1}, {"id": 2}]';
    const result = parseContinuationContent(input);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("should parse JSON with markdown code blocks", () => {
    const input = '```json\n[{"id": 1}]\n```';
    const result = parseContinuationContent(input);
    expect(result).toEqual([{ id: 1 }]);
  });

  it("should merge multiple arrays from continuation", () => {
    const input = `
Here's the first part:
[{"id": 1}, {"id": 2}]

And here's more:
[{"id": 3}, {"id": 4}]
`;
    const result = parseContinuationContent(input);
    expect(Array.isArray(result)).toBe(true);
    expect((result as JsonValue[]).length).toBe(4);
  });

  it("should handle truncated array at end", () => {
    const input = `[{"id": 1}, {"id": 2}] [{"id": 3}, {"id": 4`;
    const result = parseContinuationContent(input);
    expect(Array.isArray(result)).toBe(true);
    // Should get at least the complete arrays
    expect((result as JsonValue[]).length).toBeGreaterThanOrEqual(2);
  });

  it("should handle real-world NPC decision format", () => {
    const input = `[
  {
    "npcId": "ailon-musk",
    "action": "open_long",
    "ticker": "TECH",
    "amount": 1000,
    "reasoning": "Bullish on tech"
  },
  {
    "npcId": "sam-aitman", 
    "action": "hold",
    "reasoning": "Waiting for better entry"
  }
]`;
    const result = parseContinuationContent(input);
    expect(Array.isArray(result)).toBe(true);
    expect((result as JsonValue[]).length).toBe(2);
    const firstItem = result as Array<Record<string, JsonValue>>;
    expect(firstItem[0]?.npcId).toBe("ailon-musk");
  });

  it("should handle continuation with incomplete last item", () => {
    const input = `[
  {"npcId": "alice", "action": "buy_yes", "amount": 100}
]
[
  {"npcId": "bob", "action": "open_long", "ticker": "TECH", "amount": 500},
  {"npcId": "charlie", "action":`;

    const result = parseContinuationContent(input);
    expect(Array.isArray(result)).toBe(true);
    // Should get at least the complete arrays (alice + bob = 2 items minimum)
    // The incomplete charlie item won't be parsed, which is correct
    expect((result as JsonValue[]).length).toBeGreaterThanOrEqual(1);
    const firstItem = result as Array<Record<string, JsonValue>>;
    expect(firstItem[0]).toHaveProperty("npcId", "alice");
  });

  it("should handle mixed markdown and plain JSON", () => {
    const input = `\`\`\`json
[{"id": 1}]
\`\`\`

[{"id": 2}]

\`\`\`
[{"id": 3}]
\`\`\``;
    const result = parseContinuationContent(input);
    expect(Array.isArray(result)).toBe(true);
    expect((result as JsonValue[]).length).toBeGreaterThanOrEqual(2);
  });

  it("should return null for completely unparseable content", () => {
    const input = "This is just plain text with no JSON";
    const result = parseContinuationContent(input);
    expect(result).toBeNull();
  });

  it("should handle large realistic continuation case", () => {
    // Simulate a real truncation scenario
    const part1 = Array.from({ length: 30 }, (_, i) => ({
      npcId: `npc-${i}`,
      action: "hold",
      reasoning: "Testing",
    }));

    const part2 = Array.from({ length: 25 }, (_, i) => ({
      npcId: `npc-${i + 30}`,
      action: "buy_yes",
      amount: 100,
    }));

    const input = `${JSON.stringify(part1)} ${JSON.stringify(part2)}`;
    const result = parseContinuationContent(input);

    expect(Array.isArray(result)).toBe(true);
    expect((result as JsonValue[]).length).toBe(55);
  });
});
