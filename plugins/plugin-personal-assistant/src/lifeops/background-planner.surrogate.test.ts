/**
 * Surrogate-safe truncation for background-planner error output (200 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncate200(raw: string): string {
  return truncateWellFormed(toWellFormedUnicode(raw), 200);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("background-planner surrogate handling", () => {
  it("200 backs off at surrogate (199+fox->199)", () => {
    const input = `${"a".repeat(199)}🦊${"b".repeat(50)}`;
    const out = truncate200(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.length).toBe(199);
  });

  it("200 preserves fitting emoji (198+fox intact)", () => {
    const input = `${"a".repeat(198)}🦊`;
    const out = truncate200(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(`${"a".repeat(198)}🦊`);
  });

  it("short raw passes through", () => {
    const input = "short output";
    const out = truncate200(input);
    expect(out).toBe(input);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `output ${String.fromCharCode(0xd800)} text ${"a".repeat(300)}`;
    const out = truncate200(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
});
