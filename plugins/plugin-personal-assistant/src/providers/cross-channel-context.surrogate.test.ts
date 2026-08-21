/**
 * Surrogate-safe truncation for cross-channel-context provider (180 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncate180(hitText: string): string {
  return truncateWellFormed(
    toWellFormedUnicode(hitText.replace(/\s+/g, " ").trim()),
    180,
  );
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("cross-channel-context surrogate handling", () => {
  it("180 backs off at surrogate (179+fox->179)", () => {
    const input = "a".repeat(179) + "🦊" + "b".repeat(50);
    const out = truncate180(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(180);
    expect(out.length).toBe(179);
  });

  it("180 preserves fitting emoji (178+fox intact)", () => {
    const input = "a".repeat(178) + "🦊";
    const out = truncate180(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("a".repeat(178) + "🦊");
  });

  it("trims and normalizes whitespace before truncation", () => {
    const input = "  hello   world  ";
    const out = truncate180(input);
    expect(out).toBe("hello world");
  });

  it("sanitizes lone high surrogate", () => {
    const lone =
      `text ${String.fromCharCode(0xd800)} content ` + "a".repeat(500);
    const out = truncate180(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
});
