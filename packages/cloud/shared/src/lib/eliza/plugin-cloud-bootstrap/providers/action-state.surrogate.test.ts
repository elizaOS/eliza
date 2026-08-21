/**
 * Regression for cloud bootstrap action-state truncateText surrogate safety (1000).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const FIELD_TEXT_LIMIT = 1000;

function truncateText(value: string, limit = FIELD_TEXT_LIMIT): string {
  const wellFormed = toWellFormedUnicode(value);
  if (wellFormed.length <= limit) return wellFormed;
  const budget = Math.max(0, limit - 3);
  return `${truncateWellFormed(wellFormed, budget)}...`;
}

function isWellFormed(v: string): boolean {
  if (!v) return true;
  if (typeof (v as unknown as { isWellFormed?: () => boolean }).isWellFormed === "function")
    return (v as unknown as { isWellFormed: () => boolean }).isWellFormed();
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = v.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

describe("cloud bootstrap action-state truncateText well-formed", () => {
  it("keeps surrogate pair intact at 1000-char boundary", () => {
    const budget = FIELD_TEXT_LIMIT - 3; // 997
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(budget - 1)}${fox}${"b".repeat(50)}`;
    const out = truncateText(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(FIELD_TEXT_LIMIT);
    expect(out.endsWith("...")).toBe(true);
    expect(out).not.toContain("\uD83E");
  });

  it("preserves fitting emoji under limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(500)}${fox}`;
    const out = truncateText(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("sanitizes lone surrogate before truncation", () => {
    const lone = `action ${String.fromCharCode(0xd800)} ${"a".repeat(1500)}`;
    const out = truncateText(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(FIELD_TEXT_LIMIT);
  });

  it("sanitizes lone surrogate without truncation when fitting", () => {
    const lone = `action ${String.fromCharCode(0xd800)} ok`;
    const out = truncateText(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("action \uFFFD ok");
  });
});
