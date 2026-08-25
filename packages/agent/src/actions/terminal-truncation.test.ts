/**
 * Exercises complete terminal output through the production formatting helpers.
 */
import { describe, expect, it } from "vitest";
import { completeOutputBlock, normalizeTerminalOutput } from "./terminal.ts";

function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("terminal output preservation", () => {
  it("keeps the complete output block", () => {
    const content = "x".repeat(4_000);
    expect(completeOutputBlock(content)).toBe(content);
  });

  it("never leaves a lone surrogate at either terminal boundary", () => {
    const content = "a😀".repeat(6_000);

    expect(hasLoneSurrogate(completeOutputBlock(content))).toBe(false);
    expect(hasLoneSurrogate(normalizeTerminalOutput(content))).toBe(false);
  });

  it("normalizes empty display blocks without shortening data", () => {
    expect(completeOutputBlock("   ")).toBe("(empty)");
    expect(normalizeTerminalOutput("abcdef")).toBe("abcdef");
  });
});
