/**
 * Unit tests for character-draft-helpers: validates newline-separated array parsing and message examples.
 */
import { describe, expect, it } from "vitest";
import {
  parseArrayInput,
  parseMessageExamplesInput,
} from "./character-draft-helpers.ts";

describe("character-draft-helpers", () => {
  describe("parseArrayInput", () => {
    it("splits multiline strings into trimmed non-empty array", () => {
      const input = "  apple  \n  banana  \n\n  orange  ";
      const result = parseArrayInput(input);
      expect(result).toEqual(["apple", "banana", "orange"]);
    });

    it("returns empty array for empty string", () => {
      expect(parseArrayInput("")).toEqual([]);
      expect(parseArrayInput("   \n  \n  ")).toEqual([]);
    });
  });

  describe("parseMessageExamplesInput", () => {
    it("returns empty array for empty input", () => {
      expect(parseMessageExamplesInput("")).toEqual([]);
      expect(parseMessageExamplesInput("   ")).toEqual([]);
    });

    it("parses block of speaker: message lines into structured examples", () => {
      const input = "Alice: Hello there!\nBob: Hi Alice!";
      const result = parseMessageExamplesInput(input);
      expect(result.length).toBe(1);
      expect(result[0].examples).toEqual([
        { name: "Alice", content: { text: "Hello there!" } },
        { name: "Bob", content: { text: "Hi Alice!" } },
      ]);
    });
  });
});
