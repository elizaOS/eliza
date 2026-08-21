/**
 * Regression for pending-prompts surrogate-safe clampSnippet.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const PROMPT_SNIPPET_MAX_LENGTH = 120;

function clampSnippet(value: string): string {
  const wellFormed = toWellFormedUnicode(value.trim());
  if (wellFormed.length <= PROMPT_SNIPPET_MAX_LENGTH) return wellFormed;
  return `${truncateWellFormed(wellFormed, PROMPT_SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

describe("pending-prompts clampSnippet well-formed", () => {
  it("keeps surrogate pairs intact at 119 budget", () => {
    const text = `${"a".repeat(118)}🦊${"b".repeat(50)}`;
    const out = clampSnippet(text);
    expect(out.length).toBeLessThanOrEqual(PROMPT_SNIPPET_MAX_LENGTH);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("preserves fitting emoji", () => {
    const text = `${"a".repeat(50)}🦊`;
    const out = clampSnippet(text);
    expect(out).toBe(text);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `prompt \uD800 ${"b".repeat(200)}`;
    const out = clampSnippet(lone);
    expect(out).toContain("\uFFFD");
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone low without truncation", () => {
    const lone = "prompt \uDC00 check";
    const out = clampSnippet(lone);
    expect(out).toBe("prompt \uFFFD check");
    expect(isWellFormed(out)).toBe(true);
  });
});
