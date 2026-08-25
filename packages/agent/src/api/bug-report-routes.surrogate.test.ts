/**
 * Regression for bug-report input sanitization surrogate safety.
 */

import { describe, expect, it } from "vitest";
import { sanitize } from "./bug-report-routes.ts";

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

describe("bug-report sanitize surrogate safety", () => {
  it("keeps surrogate pair intact at custom maxLen boundary", () => {
    const maxLen = 100;
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(99)}${fox}${"b".repeat(50)}`;
    const out = sanitize(input, maxLen);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(99);
  });

  it("preserves HTML stripped content with emojis safely", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `<div>Crash report ${fox} error</div>`;
    const out = sanitize(input, 10_000);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(`Crash report ${fox} error`);
  });

  it("sanitizes lone surrogate in report body", () => {
    const lone = `stack ${String.fromCharCode(0xd800)} trace ${"a".repeat(200)}`;
    const out = sanitize(lone, 100);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(100);
  });
});
