/**
 * Surrogate-safe truncation for room-policy directive (240 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const ONE_LINE_MAX = 240;
function truncateDirective(directive: string): string {
  return truncateWellFormed(toWellFormedUnicode(directive), ONE_LINE_MAX);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("room-policy surrogate handling", () => {
  it("240 backs off at surrogate (239+fox->239)", () => {
    const input = `${"a".repeat(239)}🦊${"b".repeat(50)}`;
    const out = truncateDirective(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.length).toBe(239);
  });

  it("240 preserves fitting emoji (238+fox intact)", () => {
    const input = `${"a".repeat(238)}🦊`;
    const out = truncateDirective(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(`${"a".repeat(238)}🦊`);
  });

  it("short directive passes through", () => {
    const input = "This room is in handoff mode";
    const out = truncateDirective(input);
    expect(out).toBe(input);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `directive ${String.fromCharCode(0xd800)} content ${"a".repeat(500)}`;
    const out = truncateDirective(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
});
