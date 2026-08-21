/**
 * Surrogate-safe truncation for autofill device-bus error detail (500 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncate500(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), 500);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("autofill surrogate handling", () => {
  it("500 backs off at surrogate (499+fox->499)", () => {
    const input = `${"a".repeat(499)}🦊${"b".repeat(50)}`;
    const out = truncate500(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.length).toBe(499);
  });

  it("500 preserves fitting emoji (498+fox intact)", () => {
    const input = `${"a".repeat(498)}🦊`;
    const out = truncate500(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(`${"a".repeat(498)}🦊`);
  });

  it("short detail passes through", () => {
    const input = "short error detail";
    const out = truncate500(input);
    expect(out).toBe(input);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `error ${String.fromCharCode(0xd800)} details ${"a".repeat(1000)}`;
    const out = truncate500(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
});
