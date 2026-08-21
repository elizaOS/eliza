/**
 * Regression for sub-agent-router preview surrogate safety (200).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function preview(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text.trim()), 200);
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
describe("sub-agent-router preview well-formed", () => {
  it("200 keeps surrogate intact", () => {
    const e = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(199)}${e}${"b".repeat(20)}`;
    const out = preview(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
  });
  it("preserves fitting emoji", () => {
    const e = String.fromCharCode(0xd83d, 0xde00);
    const input = `${"a".repeat(198)}${e}`;
    const out = preview(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes(e)).toBe(true);
  });
  it("sanitizes lone surrogate", () => {
    const lone = `preview ${String.fromCharCode(0xd800)} text`;
    const out = preview(`${lone}${"x".repeat(300)}`);
    expect(isWellFormed(out)).toBe(true);
  });
  it("short passthrough", () => {
    expect(preview("short")).toBe("short");
  });
  it("sweep around 200 well-formed", () => {
    const e = String.fromCharCode(0xd83e, 0xdd8a);
    for (let n = 195; n <= 205; n++) {
      const input = `${"x".repeat(n)}${e}${"y".repeat(20)}`;
      const out = preview(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(200);
    }
  });
});
