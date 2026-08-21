/**
 * Surrogate-safe truncation for screen-context heuristic text (1024 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const HEURISTIC_TEXT_LIMIT = 1024;
function normalizeText(value: string | null | undefined): string {
  return truncateWellFormed(
    toWellFormedUnicode((value ?? "").replace(/\s+/g, " ").trim()),
    HEURISTIC_TEXT_LIMIT,
  );
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("screen-context surrogate handling", () => {
  it("1024 backs off at surrogate (1023+fox->1023)", () => {
    const input = "a".repeat(1023) + "🦊" + "b".repeat(50);
    const out = normalizeText(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(1024);
    expect(out.length).toBe(1023);
  });

  it("1024 preserves fitting emoji (1022+fox intact)", () => {
    const input = "a".repeat(1022) + "🦊";
    const out = normalizeText(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("a".repeat(1022) + "🦊");
  });

  it("normalizes whitespace and trims", () => {
    const input = "  hello   world  ";
    const out = normalizeText(input);
    expect(out).toBe("hello world");
  });

  it("sanitizes lone high surrogate", () => {
    const lone =
      `text ${String.fromCharCode(0xd800)} content ` + "a".repeat(2000);
    const out = normalizeText(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("handles null/undefined", () => {
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
  });
});
