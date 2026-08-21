/**
 * Surrogate-safe truncation for google-plugin-delegates snippet (240 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncate240(bodyText: string | undefined): string {
  return bodyText ? truncateWellFormed(toWellFormedUnicode(bodyText), 240) : "";
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("google-plugin-delegates snippet surrogate handling", () => {
  it("240 backs off at surrogate (239+fox->239)", () => {
    const input = `${"a".repeat(239)}🦊${"b".repeat(50)}`;
    const out = truncate240(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.length).toBe(239);
  });

  it("240 preserves fitting emoji (238+fox intact)", () => {
    const input = `${"a".repeat(238)}🦊`;
    const out = truncate240(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(`${"a".repeat(238)}🦊`);
  });

  it("short bodyText passes through", () => {
    const input = "short body";
    const out = truncate240(input);
    expect(out).toBe(input);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `body ${String.fromCharCode(0xd800)} text ${"a".repeat(500)}`;
    const out = truncate240(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("undefined bodyText returns empty", () => {
    expect(truncate240(undefined)).toBe("");
  });
});
