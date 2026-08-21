/**
 * Regression for LifeOps work-threads surrogate-safe compactText.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function compactTextWellFormed(value: string, maxLength: number): string {
  const wellFormed = toWellFormedUnicode(value.trim());
  if (wellFormed.length <= maxLength) return wellFormed;
  return `${truncateWellFormed(wellFormed, maxLength - 3).trimEnd()}...`;
}

describe("work-threads compactText well-formed", () => {
  it("keeps surrogate pairs intact at 120 title budget", () => {
    const text = `${"a".repeat(117)}🦊${"b".repeat(50)}`;
    const out = compactTextWellFormed(text, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith("...")).toBe(true);
  });

  it("keeps surrogate pairs intact at 500 summary budget", () => {
    const text = `${"a".repeat(497)}🦊${"b".repeat(50)}`;
    const out = compactTextWellFormed(text, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone surrogates", () => {
    const lone = `thread \uD800 summary ${"b".repeat(600)}`;
    const out = compactTextWellFormed(lone, 500);
    expect(out).toContain("\uFFFD");
    expect(isWellFormed(out)).toBe(true);
  });

  it("preserves fitting emoji", () => {
    const text = `${"a".repeat(50)}🦊`;
    const out = compactTextWellFormed(text, 120);
    expect(out).toBe(text);
    expect(isWellFormed(out)).toBe(true);
  });
});
