/**
 * Regression for handoff reason surrogate-safe normalizeReason.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function normalizeReason(reason: string): string {
  const wellFormed = toWellFormedUnicode(reason.trim());
  if (wellFormed.length <= 200) return wellFormed;
  return truncateWellFormed(wellFormed, 200);
}

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

describe("handoff normalizeReason well-formed", () => {
  it("keeps surrogate pairs intact at 200 boundary", () => {
    const text = `${"a".repeat(199)}🦊${"b".repeat(50)}`;
    const out = normalizeReason(text);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(isWellFormed(out)).toBe(true);
  });

  it("preserves fitting emoji", () => {
    const text = `${"a".repeat(50)}🦊`;
    const out = normalizeReason(text);
    expect(out).toBe(text);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone surrogates", () => {
    const lone = `handoff \uD800 ${"b".repeat(300)}`;
    const out = normalizeReason(lone);
    expect(out).toContain("\uFFFD");
    expect(isWellFormed(out)).toBe(true);
  });

  it("trims and sanitizes without truncation", () => {
    const lone = "  handoff \uDC00 reason  ";
    const out = normalizeReason(lone);
    expect(out).toBe("handoff \uFFFD reason");
    expect(isWellFormed(out)).toBe(true);
  });
});
