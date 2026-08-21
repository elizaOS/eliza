/**
 * Regression for global-pause reason surrogate-safe normalizeWindow.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function normalizeReasonWellFormed(reason: string): string {
  const wellFormed = toWellFormedUnicode(reason.trim());
  return wellFormed.length <= 200
    ? wellFormed
    : truncateWellFormed(wellFormed, 200);
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

describe("global-pause normalizeWindow reason well-formed", () => {
  it("keeps surrogate pairs intact at 200", () => {
    const text = `${"a".repeat(199)}🦊${"b".repeat(50)}`;
    const out = normalizeReasonWellFormed(text);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(isWellFormed(out)).toBe(true);
  });

  it("preserves fitting", () => {
    const text = `${"a".repeat(50)}🦊`;
    expect(normalizeReasonWellFormed(text)).toBe(text);
  });

  it("sanitizes lone", () => {
    const lone = `pause \uD800 ${"b".repeat(300)}`;
    const out = normalizeReasonWellFormed(lone);
    expect(out).toContain("\uFFFD");
    expect(isWellFormed(out)).toBe(true);
  });
});
