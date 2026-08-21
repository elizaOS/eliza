/**
 * Surrogate-safe truncation for resolve-request reason chip labels (48 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncateReason(reason: string, max = 48): string {
  const trimmed = toWellFormedUnicode(reason.trim());
  if (trimmed.length <= max) {
    return trimmed;
  }
  const budget = Math.max(0, max - 1);
  return `${truncateWellFormed(trimmed, budget)}…`;
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("resolve-request reason surrogate handling", () => {
  it("48 backs off at surrogate (47 budget with fox)", () => {
    const max = 48;
    const budget = max - 1; // 47
    const input = `${"a".repeat(budget - 1)}🦊${"b".repeat(50)}`;
    const out = truncateReason(input, max);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(max);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("\uD83E");
  });

  it("48 preserves fitting emoji", () => {
    const input = `${"a".repeat(40)}🦊`;
    const out = truncateReason(input, 48);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("sanitizes lone high surrogate before truncation", () => {
    const lone = `reason ${String.fromCharCode(0xd800)} ${"a".repeat(200)}`;
    const out = truncateReason(lone, 48);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(48);
  });

  it("sanitizes lone surrogate without truncation when fitting under limit", () => {
    const lone = `reason ${String.fromCharCode(0xd800)} ok`;
    const out = truncateReason(lone, 48);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("reason \uFFFD ok");
  });
});
