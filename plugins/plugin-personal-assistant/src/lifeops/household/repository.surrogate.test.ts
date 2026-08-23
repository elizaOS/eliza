/**
 * Surrogate-safe truncation for household repository (512 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncate512(error: string): string {
  return truncateWellFormed(toWellFormedUnicode(error), 512);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("household repository surrogate handling", () => {
  it("512 backs off at surrogate", () => {
    const input = `${"a".repeat(511)}🦊${"b".repeat(20)}`;
    const out = truncate512(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(512);
    expect(out.length).toBe(511);
  });

  it("512 preserves fitting emoji", () => {
    const input = `${"a".repeat(510)}🦊`;
    const out = truncate512(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(`${"a".repeat(510)}🦊`);
  });

  it("sanitizes lone surrogate", () => {
    const lone = `error \ud800 details ${"a".repeat(1000)}`;
    const out = truncate512(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
});
