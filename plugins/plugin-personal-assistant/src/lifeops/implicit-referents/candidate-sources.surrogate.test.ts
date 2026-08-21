/**
 * Surrogate-safe truncation for candidate-sources label (59 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function label59(summary: string): string {
  const wellFormed = toWellFormedUnicode(summary);
  return wellFormed.length > 60
    ? `${truncateWellFormed(wellFormed, 59).trimEnd()}…`
    : wellFormed;
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("candidate-sources surrogate handling", () => {
  it("59 backs off at surrogate (58+fox->58 before …)", () => {
    const input = `${"a".repeat(58)}🦊${"b".repeat(50)}`;
    const out = label59(input);
    expect(isWellFormed(out)).toBe(true);
    const core = out.slice(0, -1).trimEnd();
    expect(core.length).toBe(58);
  });

  it("59 preserves fitting emoji (57+fox intact before …)", () => {
    const input = `${"a".repeat(57)}🦊${"b".repeat(50)}`;
    const out = label59(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.slice(0, -1).trimEnd()).toBe(`${"a".repeat(57)}🦊`);
  });

  it("short summary passes through", () => {
    const input = "short summary";
    const out = label59(input);
    expect(out).toBe(input);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `summary ${String.fromCharCode(0xd800)} text ${"a".repeat(100)}`;
    const out = label59(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
});
