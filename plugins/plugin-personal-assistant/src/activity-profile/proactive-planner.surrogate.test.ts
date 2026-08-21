/**
 * Regression for proactive-planner summarizeSnippet surrogate-safe.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function summarizeSnippet(value: string): string | null {
  const wellFormed = toWellFormedUnicode(value.trim());
  if (wellFormed.length === 0) return null;
  if (wellFormed.length <= 72) return wellFormed;
  return `${truncateWellFormed(wellFormed, 69).trimEnd()}...`;
}

function isWellFormed(value: string): boolean {
  if (!value) return true;
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

describe("proactive-planner summarizeSnippet well-formed", () => {
  it("keeps surrogate pairs intact at 69 budget", () => {
    const text = `${"a".repeat(68)}🦊${"b".repeat(50)}`;
    const out = summarizeSnippet(text);
    expect(out).not.toBeNull();
    expect(out?.length).toBeLessThanOrEqual(72);
    expect(isWellFormed(out!)).toBe(true);
    expect(out?.endsWith("...")).toBe(true);
  });

  it("preserves fitting", () => {
    const text = `${"a".repeat(50)}🦊`;
    expect(summarizeSnippet(text)).toBe(text);
  });

  it("sanitizes lone high", () => {
    const lone = `snippet \uD800 ${"b".repeat(100)}`;
    const out = summarizeSnippet(lone);
    expect(out).toContain("\uFFFD");
    expect(isWellFormed(out!)).toBe(true);
  });

  it("sanitizes lone low without truncation", () => {
    const lone = "snippet \uDC00 test";
    const out = summarizeSnippet(lone);
    expect(out).toBe("snippet \uFFFD test");
    expect(isWellFormed(out!)).toBe(true);
  });

  it("returns null for empty", () => {
    expect(summarizeSnippet("   ")).toBeNull();
  });
});
