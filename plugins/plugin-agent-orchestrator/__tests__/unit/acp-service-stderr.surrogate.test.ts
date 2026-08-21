/**
 * Regression for acp-service stderr/line surrogate safety (500/200).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function clamp500(s: string): string {
  const w = toWellFormedUnicode(s.trim());
  return w.length > 500 ? truncateWellFormed(w, 500) : w;
}
function clamp200(s: string): string {
  return truncateWellFormed(toWellFormedUnicode(s), 200);
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
describe("acp-service well-formed", () => {
  it("500 keeps surrogate intact", () => {
    const e = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(499)}${e}${"b".repeat(20)}`;
    const out = clamp500(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(500);
  });
  it("200 keeps surrogate intact", () => {
    const e = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(199)}${e}${"b".repeat(20)}`;
    const out = clamp200(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
  });
  it("sanitizes lone surrogate", () => {
    const lone = `err ${String.fromCharCode(0xd800)} text`;
    const out = clamp500(`${lone}${"x".repeat(600)}`);
    expect(isWellFormed(out)).toBe(true);
  });
  it("short passthrough", () => {
    expect(clamp500("short")).toBe("short");
    expect(clamp200("short")).toBe("short");
  });
  it("sweep around boundaries well-formed", () => {
    const e = String.fromCharCode(0xd83e, 0xdd8a);
    for (const n of [495, 499, 500, 501, 195, 199, 200, 201]) {
      const cap = n > 300 ? 500 : 200;
      const fn = cap === 500 ? clamp500 : clamp200;
      const input = `${"x".repeat(n)}${e}${"y".repeat(20)}`;
      const out = fn(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(cap);
    }
  });
});
