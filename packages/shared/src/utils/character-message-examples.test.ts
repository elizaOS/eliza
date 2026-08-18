/**
 * Unit tests for character message example normalization in packages/shared/src/utils/character-message-examples.ts.
 * Exercises markdown fence parsing, JSON extraction, speaker role alias mapping, actions array preservation,
 * and empty text filtering.
 */
import { describe, expect, it } from "vitest";
import { normalizeCharacterMessageExamples } from "./character-message-examples.js";

describe("character-message-examples utilities", () => {
  describe("normalizeCharacterMessageExamples", () => {
    it("normalizes a standard message example group array", () => {
      const input = [
        [
          { user: "Alice", content: { text: "Hello there!" } },
          { user: "Bob", content: { text: "Hi Alice!" } },
        ],
      ];

      const result = normalizeCharacterMessageExamples(input, "Bob");
      expect(result).toHaveLength(1);
      expect(result[0].examples).toHaveLength(2);
      expect(result[0].examples[0]).toEqual({
        name: "Alice",
        content: { text: "Hello there!" },
      });
      expect(result[0].examples[1]).toEqual({
        name: "Bob",
        content: { text: "Hi Alice!" },
      });
    });

    it("normalizes speaker role aliases to canonical names", () => {
      const input = [
        [
          { role: "user", content: { text: "Can you help?" } },
          { role: "assistant", content: { text: "Sure thing." } },
          { role: "human", content: { text: "Next question." } },
          { role: "model", content: { text: "Got it." } },
          { role: "customer", content: { text: "Thanks!" } },
          { role: "ai", content: { text: "Welcome!" } },
        ],
      ];

      const result = normalizeCharacterMessageExamples(input, "Eliza");
      expect(result).toHaveLength(1);
      const { examples } = result[0];
      expect(examples[0].name).toBe("{{user1}}");
      expect(examples[1].name).toBe("Eliza");
      expect(examples[2].name).toBe("{{user1}}");
      expect(examples[3].name).toBe("Eliza");
      expect(examples[4].name).toBe("{{user1}}");
      expect(examples[5].name).toBe("Eliza");
    });

    it("parses JSON strings wrapped in markdown code fences", () => {
      const input = `\`\`\`json
[
  [
    { "user": "user", "text": "What is the weather?" },
    { "user": "assistant", "text": "It is sunny today." }
  ]
]
\`\`\``;

      const result = normalizeCharacterMessageExamples(input, "WeatherBot");
      expect(result).toHaveLength(1);
      expect(result[0].examples[0]).toEqual({
        name: "{{user1}}",
        content: { text: "What is the weather?" },
      });
      expect(result[0].examples[1]).toEqual({
        name: "WeatherBot",
        content: { text: "It is sunny today." },
      });
    });

    it("parses objects with messageExamples property", () => {
      const input = {
        messageExamples: [
          [
            { user: "user", text: "Help me." },
            { user: "agent", text: "I am here." },
          ],
        ],
      };

      const result = normalizeCharacterMessageExamples(input, "Helper");
      expect(result).toHaveLength(1);
      expect(result[0].examples[0].name).toBe("{{user1}}");
      expect(result[0].examples[1].name).toBe("Helper");
    });

    it("preserves actions array while filtering empty action entries", () => {
      const input = [
        [
          {
            user: "Alice",
            content: {
              text: "Search for info",
              actions: ["SEARCH_WEB", "   ", 123 as unknown as string, ""],
            },
          },
        ],
      ];

      const result = normalizeCharacterMessageExamples(input, "Bob");
      expect(result).toHaveLength(1);
      expect(result[0].examples[0].content.actions).toEqual(["SEARCH_WEB"]);
    });

    it("skips messages with missing or empty text", () => {
      const input = [
        [
          { user: "Alice", content: { text: "" } },
          { user: "Bob", content: { text: "Valid message" } },
          { user: "Charlie", message: "   " },
        ],
      ];

      const result = normalizeCharacterMessageExamples(input, "Bob");
      expect(result).toHaveLength(1);
      expect(result[0].examples).toHaveLength(1);
      expect(result[0].examples[0].name).toBe("Bob");
      expect(result[0].examples[0].content.text).toBe("Valid message");
    });

    it("returns empty array for invalid JSON or non-array inputs", () => {
      expect(normalizeCharacterMessageExamples("invalid json string")).toEqual(
        [],
      );
      expect(normalizeCharacterMessageExamples(null)).toEqual([]);
      expect(normalizeCharacterMessageExamples(12345)).toEqual([]);
      expect(normalizeCharacterMessageExamples({})).toEqual([]);
    });
  });
});
