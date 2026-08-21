/**
 * Regression for lane-planner title surrogate safety (80).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function titleClamp(v: string): string {
  return truncateWellFormed(toWellFormedUnicode(v), 80);
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
describe("lane-planner title well-formed", () => {
  it("80 keeps surrogate intact", () => {
    const e = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(79)}${e}${"b".repeat(20)}`;
    const out = titleClamp(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(80);
  });
  it("preserves fitting emoji", () => {
    const e = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(78)}${e}`;
    const out = titleClamp(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes(e)).toBe(true);
  });
  it("sanitizes lone surrogate", () => {
    const lone = `title ${String.fromCharCode(0xd800)} test`;
    const out = titleClamp(`${lone}${"x".repeat(100)}`);
    expect(isWellFormed(out)).toBe(true);
  });
  it("short passthrough", () => {
    expect(titleClamp("short")).toBe("short");
  });
  it("sweep around 80 well-formed", () => {
    const e = String.fromCharCode(0xd83e, 0xdd8a);
    for (let n = 75; n <= 85; n++) {
      const input = `${"x".repeat(n)}${e}${"y".repeat(20)}`;
      const out = titleClamp(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(80);
    }
  });
});
