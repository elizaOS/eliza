/**
 * Validates that Ollama embedding input is Unicode-safe and either preserved
 * completely or rejected before a partial value can reach the provider.
 */
import { describe, expect, it } from "vitest";
import { validateEmbedInput } from "../utils/embed-context.ts";

describe("validateEmbedInput", () => {
  it("preserves a complete string within the provider window", () => {
    const text = `${"a".repeat(8)}🦊`;
    expect(validateEmbedInput(text, 10)).toBe(text);
  });

  it("rejects a string that exceeds the provider window", () => {
    const text = `${"a".repeat(9)}🦊tail`;
    expect(() => validateEmbedInput(text, 10)).toThrow(
      "Embedding input exceeds the provider-safe limit (15/10 chars)"
    );
  });

  it("sanitizes lone surrogates without dropping content", () => {
    const text = "a\ud800bc";
    const output = validateEmbedInput(text, 10) as string;
    expect(output).toBe("a\ufffdbc");
    expect(output.isWellFormed()).toBe(true);
  });

  it("rejects the entire array if any element exceeds the window", () => {
    expect(() => validateEmbedInput(["short", "x".repeat(11)], 10)).toThrow(
      "Embedding input exceeds the provider-safe limit (11/10 chars)"
    );
  });
});
