/**
 * Regression for LifeOps goal-title surrogate-safe truncation.
 * Isolated logic test to avoid scheduler graph import.
 */

import { describe, expect, it } from "vitest";
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";

const GOAL_TITLE_MAX_LENGTH = 80;

function truncateGoalTitle(title: string): string {
  const wellFormed = toWellFormedUnicode(title.trim());
  if (wellFormed.length <= GOAL_TITLE_MAX_LENGTH) return wellFormed;
  return `${truncateWellFormed(wellFormed, GOAL_TITLE_MAX_LENGTH - 1).trimEnd()}…`;
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

describe("truncateGoalTitle well-formed", () => {
  it("keeps surrogate pairs intact at 79 budget", () => {
    const text = `${"a".repeat(78)}🦊${"b".repeat(50)}`;
    const out = truncateGoalTitle(text);
    expect(out.length).toBeLessThanOrEqual(GOAL_TITLE_MAX_LENGTH);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("preserves fitting emoji", () => {
    const text = `${"a".repeat(50)}🦊`;
    const out = truncateGoalTitle(text);
    expect(out).toBe(text);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate before truncation", () => {
    const lone = `goal \uD800 ${"b".repeat(100)}`;
    const out = truncateGoalTitle(lone);
    expect(out).toContain("\uFFFD");
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone low surrogate without truncation", () => {
    const lone = "goal \uDC00 title";
    const out = truncateGoalTitle(lone);
    expect(out).toBe("goal \uFFFD title");
    expect(isWellFormed(out)).toBe(true);
  });
});
