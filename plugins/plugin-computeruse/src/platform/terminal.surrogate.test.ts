/**
 * Regression for computeruse terminal output truncation surrogate safety (5000).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncateOutput(output: string): string {
  const wellFormed = toWellFormedUnicode(output);
  return truncateWellFormed(wellFormed, 5000);
}

function isWellFormed(v: string): boolean {
  if (!v) return true;
  if (
    typeof (v as unknown as { isWellFormed?: () => boolean }).isWellFormed ===
    "function"
  )
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

describe("computeruse terminal output truncateOutput well-formed", () => {
  it("keeps surrogate pair intact at 5000-char boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(4999)}${fox}${"b".repeat(50)}`;
    const out = truncateOutput(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(5000);
    expect(out.length).toBe(4999);
    expect(out).not.toContain("\uD83E");
  });

  it("preserves fitting emoji under limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(4000)}${fox}`;
    const out = truncateOutput(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("sanitizes lone surrogate before truncation", () => {
    const lone = `term ${String.fromCharCode(0xd800)} ${"a".repeat(6000)}`;
    const out = truncateOutput(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(5000);
  });

  it("sanitizes lone surrogate without truncation when fitting", () => {
    const lone = `term ${String.fromCharCode(0xd800)} ok`;
    const out = truncateOutput(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("term \uFFFD ok");
  });
});
