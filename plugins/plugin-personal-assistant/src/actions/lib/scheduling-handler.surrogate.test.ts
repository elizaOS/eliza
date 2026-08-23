/**
 * Surrogate-safe truncation for scheduling-handler (4096/1024 caps).
 * Verifies caps never split an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncate4096(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text.trim()), 4096);
}
function truncate1024(value: string): string {
  return truncateWellFormed(toWellFormedUnicode(value), 1024);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("scheduling-handler surrogate handling", () => {
  it("4096 backs off at surrogate", () => {
    const input = `${"a".repeat(4095)}🦊${"b".repeat(20)}`;
    const out = truncate4096(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.length).toBe(4095);
  });

  it("4096 preserves fitting emoji", () => {
    const input = `${"a".repeat(4094)}🦊`;
    const out = truncate4096(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(`${"a".repeat(4094)}🦊`);
  });

  it("1024 backs off at surrogate", () => {
    const input = `${"a".repeat(1023)}🦊${"b".repeat(20)}`;
    const out = truncate1024(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(1024);
    expect(out.length).toBe(1023);
  });

  it("sanitizes lone surrogate", () => {
    const lone = `ok \ud800 value ${"a".repeat(5000)}`;
    const out = truncate4096(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
});
