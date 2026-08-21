/**
 * Surrogate-safe truncation for website-block candidate normalization (1024 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncate1024(item: string): string {
  return truncateWellFormed(toWellFormedUnicode(item.trim()), 1024);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("website-block surrogate handling", () => {
  it("1024 backs off at surrogate (1023+fox->1023)", () => {
    const input = "a".repeat(1023) + "🦊" + "b".repeat(50);
    const out = truncate1024(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(1024);
    expect(out.length).toBe(1023);
  });

  it("1024 preserves fitting emoji (1022+fox intact)", () => {
    const input = "a".repeat(1022) + "🦊";
    const out = truncate1024(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("a".repeat(1022) + "🦊");
  });

  it("trims before truncation", () => {
    const input = "  hello world  ";
    const out = truncate1024(input);
    expect(out).toBe("hello world");
  });

  it("sanitizes lone high surrogate", () => {
    const lone =
      `site ${String.fromCharCode(0xd800)} example ` + "a".repeat(2000);
    const out = truncate1024(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
});
