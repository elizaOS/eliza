/**
 * Regression for interruption-decider surrogate safety (500/800/160).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function clamp500(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text.trim()), 500);
}
function clamp800(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text.trim()), 800);
}
function clamp160(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text.trim()), 160);
}
function isWellFormed(value: string): boolean {
  if (!value) return true;
  if (
    typeof (value as unknown as { isWellFormed?: () => boolean })
      .isWellFormed === "function"
  )
    return (value as unknown as { isWellFormed: () => boolean }).isWellFormed();
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
describe("interruption-decider well-formed", () => {
  it("500 keeps surrogate intact", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(499)}${emoji}${"b".repeat(20)}`;
    const out = clamp500(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(500);
  });
  it("800 keeps surrogate intact", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(799)}${emoji}${"b".repeat(20)}`;
    const out = clamp800(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(800);
  });
  it("160 keeps surrogate intact", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(159)}${emoji}${"b".repeat(20)}`;
    const out = clamp160(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(160);
  });
  it("short passthrough", () => {
    expect(clamp500("short")).toBe("short");
    expect(clamp800("short")).toBe("short");
  });
  it("sweep around boundaries well-formed", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    for (const n of [
      495, 499, 500, 501, 795, 799, 800, 801, 155, 159, 160, 161,
    ]) {
      const cap = n < 400 ? 160 : n < 600 ? 500 : 800;
      const fn = cap === 160 ? clamp160 : cap === 500 ? clamp500 : clamp800;
      const input = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
      const out = fn(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(cap);
    }
  });
});
