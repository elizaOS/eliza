/**
 * Regression for lossless LifeOps goal-title Unicode normalization.
 * Isolated logic test to avoid scheduler graph import.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function normalizeGoalTitle(title: string): string {
  return toWellFormedUnicode(title.trim());
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

describe("normalizeGoalTitle", () => {
  it("preserves the complete title and surrogate pairs", () => {
    const text = `${"a".repeat(78)}🦊${"b".repeat(50)}`;
    const out = normalizeGoalTitle(text);
    expect(out).toBe(text);
    expect(isWellFormed(out)).toBe(true);
  });

  it("preserves fitting emoji", () => {
    const text = `${"a".repeat(50)}🦊`;
    const out = normalizeGoalTitle(text);
    expect(out).toBe(text);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes a lone high surrogate without dropping the suffix", () => {
    const lone = `goal \uD800 ${"b".repeat(100)}`;
    const out = normalizeGoalTitle(lone);
    expect(out).toContain("\uFFFD");
    expect(out.endsWith("b".repeat(100))).toBe(true);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes a lone low surrogate", () => {
    const lone = "goal \uDC00 title";
    const out = normalizeGoalTitle(lone);
    expect(out).toBe("goal \uFFFD title");
    expect(isWellFormed(out)).toBe(true);
  });
});
