/**
 * Unit tests for the legacy prompt-compression compatibility surface.
 * Descriptions must pass through byte-for-byte so model-facing instructions
 * never lose wording or meaning.
 */
import { describe, expect, it } from "vitest";
import { compressPromptDescription } from "./prompt-compression.ts";

describe("prompt-compression", () => {
  it("returns empty string for empty or non-string input", () => {
    expect(compressPromptDescription("")).toBe("");
    expect(compressPromptDescription("   ")).toBe("");
    expect(compressPromptDescription(undefined)).toBe("");
  });

  it("preserves technical code blocks, URLs, file paths, and surrounding prose", () => {
    const input =
      "Use this action in order to fetch https://api.github.com/repos using `curl` and /tmp/output.json.";
    expect(compressPromptDescription(input)).toBe(input);
  });

  it("does not strip conversational wording or contract words", () => {
    const input =
      "Provides information about the current conversation messages and parameters.";
    expect(compressPromptDescription(input)).toBe(input);
  });

  it("does not rewrite leading verbs", () => {
    for (const input of [
      "Retrieves user settings.",
      "Generates media assets.",
      "Deletes temporary files.",
    ]) {
      expect(compressPromptDescription(input)).toBe(input);
    }
  });
});
