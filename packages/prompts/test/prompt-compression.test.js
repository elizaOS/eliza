/**
 * Guards the legacy prompt-description helper as a byte-preserving identity
 * alias so compatibility imports can never rewrite model-facing text.
 */
import { describe, expect, it } from "vitest";
import { compressPromptDescription } from "../src/prompt-compression.js";

describe("compressPromptDescription compatibility alias", () => {
  it("preserves every character in authored descriptions", () => {
    const description =
      "  Retrieve every result.\nKeep `Node.js`, 2.5 MB, and https://example.com/a?b=c exactly.  ";
    expect(compressPromptDescription(description)).toBe(description);
  });

  it("maps only an absent description to the empty compatibility value", () => {
    expect(compressPromptDescription(undefined)).toBe("");
    expect(compressPromptDescription("")).toBe("");
  });
});
