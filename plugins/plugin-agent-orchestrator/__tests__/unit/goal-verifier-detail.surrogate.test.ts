/**
 * Regression for goal-llm-verifier surrogate safety (280/200).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function clamp280(s: string): string {
  return truncateWellFormed(toWellFormedUnicode(s.trim()), 280);
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
describe("goal-verifier well-formed", () => {
  it("280 keeps surrogate intact", () => {
    const e = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(279)}${e}${"b".repeat(20)}`;
    const out = clamp280(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(280);
  });
  it("200 keeps surrogate intact", () => {
    const e = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(199)}${e}${"b".repeat(20)}`;
    const out = clamp200(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
  });
  it("sanitizes lone surrogate", () => {
    const lone = `detail ${String.fromCharCode(0xd800)} test`;
    const out = clamp200(`${lone}${"x".repeat(300)}`);
    expect(isWellFormed(out)).toBe(true);
  });
  it("short passthrough", () => {
    expect(clamp280("short")).toBe("short");
    expect(clamp200("short")).toBe("short");
  });
  it("sweep around boundaries well-formed", () => {
    const e = String.fromCharCode(0xd83e, 0xdd8a);
    for (const n of [275, 279, 280, 281, 195, 199, 200, 201]) {
      const cap = n > 250 ? 280 : 200;
      const fn = cap === 280 ? clamp280 : clamp200;
      const input = `${"x".repeat(n)}${e}${"y".repeat(20)}`;
      const out = fn(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(cap);
    }
  });
});
