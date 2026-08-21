/**
 * Regression for plugin-wallet news formatter truncateText surrogate safety.
 */

import { describe, expect, it } from "vitest";
import { truncateText } from "./formatters.ts";

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

describe("plugin-wallet truncateText surrogate safety", () => {
  it("keeps surrogate pair intact at 200-char default limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(196)}${fox}${"b".repeat(50)}`;
    const out = truncateText(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("...")).toBe(true);
    expect(out).not.toContain("\uD83E");
  });

  it("preserves fitting emoji under limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `Crypto news update ${fox}`;
    const out = truncateText(input, 200);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("handles very short maxLength gracefully", () => {
    expect(truncateText("hello world", 2)).toBe("..");
    expect(truncateText("hello world", 3)).toBe("...");
  });

  it("sanitizes lone surrogate in news text", () => {
    const lone = `news ${String.fromCharCode(0xd800)} item ${"a".repeat(300)}`;
    const out = truncateText(lone, 100);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(100);
  });
});
