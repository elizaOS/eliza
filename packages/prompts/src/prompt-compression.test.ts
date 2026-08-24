/**
 * Unit tests for prompt compression: validates filler stripping,
 * word contractions, leading verb imperatives, and technical token protection.
 */
import { describe, expect, it } from "vitest";
import { compressPromptDescription } from "./prompt-compression.ts";

describe("prompt-compression", () => {
  it("returns empty string for empty or non-string input", () => {
    expect(compressPromptDescription("")).toBe("");
    expect(compressPromptDescription("   ")).toBe("");
    expect(compressPromptDescription(undefined)).toBe("");
  });

  it("preserves technical code blocks, URLs, and file paths", () => {
    const input =
      "Use this action in order to fetch https://api.github.com/repos using `curl` and /tmp/output.json.";
    const compressed = compressPromptDescription(input);
    expect(compressed).toContain("https://api.github.com/repos");
    expect(compressed).toContain("`curl`");
    expect(compressed).toContain("/tmp/output.json");
  });

  it("strips conversational filler and contracts common words", () => {
    const input =
      "Provides information about the current conversation messages and parameters.";
    const compressed = compressPromptDescription(input);
    expect(compressed).toBe(
      "Provide info about current convo msgs and params.",
    );
  });

  it("converts leading third-person verbs to imperative", () => {
    expect(compressPromptDescription("Retrieves user settings.")).toBe(
      "Get user settings.",
    );
    expect(compressPromptDescription("Generates media assets.")).toBe(
      "Generate media assets.",
    );
    expect(compressPromptDescription("Deletes temporary files.")).toBe(
      "Delete temporary files.",
    );
  });
});
