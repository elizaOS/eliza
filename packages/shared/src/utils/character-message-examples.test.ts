/**
 * Unit tests for normalizeCharacterMessageExamples in packages/shared/src/utils/character-message-examples.ts.
 * Exercises flat/nested conversation groups, JSON string and markdown code fence parsing,
 * speaker alias normalization, action arrays, empty text filtering, and agent name fallbacks.
 */
import { describe, expect, it } from "vitest";
import { normalizeCharacterMessageExamples } from "./character-message-examples.js";

describe("normalizeCharacterMessageExamples", () => {
  it("normalizes a standard message example group array", () => {
    const input = [
      [
        { user: "{{user1}}", content: { text: "hello" } },
        { user: "Agent", content: { text: "hi there" } },
      ],
    ];
    const result = normalizeCharacterMessageExamples(input);
    expect(result).toHaveLength(1);
    expect(result[0].examples).toHaveLength(2);
    expect(result[0].examples[0]).toEqual({
      name: "{{user1}}",
      content: { text: "hello" },
    });
    expect(result[0].examples[1]).toEqual({
      name: "Agent",
      content: { text: "hi there" },
    });
  });

  it("normalizes speaker role aliases to canonical names", () => {
    const input = [
      { role: "user", text: "how are you?" },
      { role: "assistant", text: "I'm great!" },
      { role: "human", message: "nice" },
      { role: "ai", message: "thank you" },
    ];
    const result = normalizeCharacterMessageExamples(input, "Eliza");
    expect(result).toHaveLength(1);
    expect(result[0].examples).toHaveLength(4);
    expect(result[0].examples[0].name).toBe("{{user1}}");
    expect(result[0].examples[1].name).toBe("Eliza");
    expect(result[0].examples[2].name).toBe("{{user1}}");
    expect(result[0].examples[3].name).toBe("Eliza");
  });

  it("falls back to 'Agent' when fallbackAgentName is blank or non-string", () => {
    const input = [{ role: "model", text: "response" }];
    const result1 = normalizeCharacterMessageExamples(input, "   ");
    expect(result1[0].examples[0].name).toBe("Agent");

    const result2 = normalizeCharacterMessageExamples(
      input,
      undefined as unknown as string,
    );
    expect(result2[0].examples[0].name).toBe("Agent");
  });

  it("parses JSON strings wrapped in markdown code fences", () => {
    const jsonWithFences =
      '```json\n[{"user": "customer", "text": "help"}, {"user": "agent", "text": "on it"}]\n```';
    const result = normalizeCharacterMessageExamples(jsonWithFences);
    expect(result).toHaveLength(1);
    expect(result[0].examples[0].name).toBe("{{user1}}");
    expect(result[0].examples[1].name).toBe("Agent");
  });

  it("parses object with messageExamples key", () => {
    const obj = {
      messageExamples: [
        [
          { speaker: "Alice", content: { text: "hey" } },
          { speaker: "{{agentName}}", content: { text: "hello" } },
        ],
      ],
    };
    const result = normalizeCharacterMessageExamples(obj, "Bot");
    expect(result).toHaveLength(1);
    expect(result[0].examples[0].name).toBe("Alice");
    expect(result[0].examples[1].name).toBe("Bot");
  });

  it("preserves actions array while filtering empty action items", () => {
    const input = [
      {
        speaker: "agent",
        content: {
          text: "executing",
          actions: ["SEARCH", "", "   ", "REPLY"],
        },
      },
    ];
    const result = normalizeCharacterMessageExamples(input);
    expect(result[0].examples[0].content.actions).toEqual(["SEARCH", "REPLY"]);
  });

  it("skips messages with missing or empty text", () => {
    const input = [
      { speaker: "user", text: "" },
      { speaker: "user", text: "   " },
      { speaker: "user", text: "valid text" },
    ];
    const result = normalizeCharacterMessageExamples(input);
    expect(result).toHaveLength(1);
    expect(result[0].examples).toHaveLength(1);
    expect(result[0].examples[0].content.text).toBe("valid text");
  });

  it("returns empty array for invalid JSON or non-array inputs", () => {
    expect(normalizeCharacterMessageExamples("not valid json")).toEqual([]);
    expect(normalizeCharacterMessageExamples(null)).toEqual([]);
    expect(normalizeCharacterMessageExamples(123)).toEqual([]);
  });
});
