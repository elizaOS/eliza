/**
 * Regression for parent-agent broker string truncation surrogate safety.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncate(value: string, maxChars: number): string {
  const compact = toWellFormedUnicode(value.replace(/\s+/g, " ").trim());
  if (compact.length <= maxChars) return compact;
  const budget = Math.max(0, maxChars - 3);
  return `${truncateWellFormed(compact, budget).trimEnd()}...`;
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

describe("parent-agent-broker truncate well-formed", () => {
  it("keeps surrogate pair intact when truncating at boundary", () => {
    const limit = 50;
    const budget = limit - 3; // 47
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(budget - 1)}${fox}${"b".repeat(20)}`;
    const out = truncate(input, limit);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(limit);
    expect(out.endsWith("...")).toBe(true);
    expect(out).not.toContain("\uD83E");
  });

  it("preserves fitting emoji", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(40)}${fox}`;
    const out = truncate(input, 50);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("sanitizes lone surrogate before truncation", () => {
    const lone = `broker ${String.fromCharCode(0xd800)} ${"a".repeat(200)}`;
    const out = truncate(lone, 50);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it("sanitizes lone surrogate without truncation when fitting", () => {
    const lone = `broker ${String.fromCharCode(0xd800)} test`;
    const out = truncate(lone, 50);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("broker \uFFFD test");
  });
});
