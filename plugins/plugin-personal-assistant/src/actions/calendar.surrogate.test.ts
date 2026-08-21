/**
 * Surrogate-safe truncation for calendar approvalSafeLabel (160 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function approvalSafeLabel(value: string): string {
  return truncateWellFormed(
    toWellFormedUnicode(
      value
        .replace(/[\r\n\t]+/g, " ")
        .replace(/[[\]]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    ),
    160,
  );
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("calendar surrogate handling", () => {
  it("160 backs off at surrogate (159+fox->159)", () => {
    const input = "a".repeat(159) + "🦊" + "b".repeat(50);
    const out = approvalSafeLabel(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.length).toBe(159);
  });

  it("160 preserves fitting emoji (158+fox intact)", () => {
    const input = "a".repeat(158) + "🦊";
    const out = approvalSafeLabel(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("a".repeat(158) + "🦊");
  });

  it("normalizes whitespace and brackets", () => {
    const input = "  hello [world] \n test  ";
    const out = approvalSafeLabel(input);
    expect(out).toBe("hello world test");
  });

  it("sanitizes lone high surrogate", () => {
    const lone =
      `title ${String.fromCharCode(0xd800)} value ` + "a".repeat(300);
    const out = approvalSafeLabel(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
});
