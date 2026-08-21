/**
 * Surrogate-safe truncation for bill-extraction (1000/120 caps).
 * Verifies caps never split an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncate1000(snippet: string): string {
  return truncateWellFormed(toWellFormedUnicode(snippet ?? ""), 1000);
}
function truncate120(value: string): string {
  return truncateWellFormed(toWellFormedUnicode(value.trim()), 120);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("bill-extraction surrogate handling", () => {
  it("1000 backs off at surrogate", () => {
    const input = "a".repeat(999) + "🦊" + "b".repeat(20);
    const out = truncate1000(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out.length).toBe(999);
  });

  it("1000 preserves fitting emoji", () => {
    const input = "a".repeat(998) + "🦊";
    const out = truncate1000(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("a".repeat(998) + "🦊");
  });

  it("120 backs off at surrogate", () => {
    const input = "a".repeat(119) + "🦊" + "b".repeat(20);
    const out = truncate120(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
  });

  it("sanitizes lone surrogate", () => {
    const lone = "ok \ud800 snippet " + "a".repeat(2000);
    const out = truncate1000(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
});
