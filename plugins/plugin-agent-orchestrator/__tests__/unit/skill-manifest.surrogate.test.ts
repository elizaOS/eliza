/**
 * Regression for skill manifest description truncation surrogate safety (200).
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const MAX_DESCRIPTION_CHARS = 200;

function truncateDescription(value: string): string {
  const cleaned = toWellFormedUnicode(value.replace(/\s+/g, " ").trim());
  if (cleaned.length <= MAX_DESCRIPTION_CHARS) return cleaned;
  const budget = Math.max(0, MAX_DESCRIPTION_CHARS - 1);
  return `${truncateWellFormed(cleaned, budget).trimEnd()}…`;
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

describe("skill-manifest truncateDescription well-formed", () => {
  it("keeps surrogate pair intact at 200-char boundary", () => {
    const budget = MAX_DESCRIPTION_CHARS - 1; // 199
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(budget - 1)}${fox}${"b".repeat(50)}`;
    const out = truncateDescription(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toContain("\uD83E");
  });

  it("preserves fitting emoji under limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(150)}${fox}`;
    const out = truncateDescription(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("sanitizes lone surrogate before truncation", () => {
    const lone = `manifest ${String.fromCharCode(0xd800)} ${"a".repeat(300)}`;
    const out = truncateDescription(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
  });

  it("sanitizes lone surrogate without truncation when fitting", () => {
    const lone = `manifest ${String.fromCharCode(0xd800)} test`;
    const out = truncateDescription(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("manifest \uFFFD test");
  });
});
