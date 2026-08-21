/**
 * Surrogate-safe truncation for creative-draft owner voice source (6000 cap).
 * Verifies cap never splits an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const MAX_OWNER_SOURCE_CHARS = 6000;
function truncate6000(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), MAX_OWNER_SOURCE_CHARS);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("creative-draft surrogate handling", () => {
  it("6000 backs off at surrogate (5999+fox->5999)", () => {
    const input = `${"a".repeat(5999)}🦊${"b".repeat(50)}`;
    const out = truncate6000(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(6000);
    expect(out.length).toBe(5999);
  });

  it("6000 preserves fitting emoji (5998+fox intact)", () => {
    const input = `${"a".repeat(5998)}🦊`;
    const out = truncate6000(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(`${"a".repeat(5998)}🦊`);
  });

  it("short text passes through", () => {
    const input = "short owner voice text";
    const out = truncate6000(input);
    expect(out).toBe(input);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `text ${String.fromCharCode(0xd800)} content ${"a".repeat(7000)}`;
    const out = truncate6000(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
});
