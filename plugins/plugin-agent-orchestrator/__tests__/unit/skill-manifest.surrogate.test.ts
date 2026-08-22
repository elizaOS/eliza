/** Skill manifest descriptions remain complete while invalid Unicode is repaired. */

import { describe, expect, it } from "vitest";
import { normalizeDescription } from "../../src/services/skill-manifest.ts";

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

describe("skill-manifest normalizeDescription", () => {
  it("preserves the complete description across the former boundary", () => {
    const formerBudget = 199;
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(formerBudget - 1)}${fox}${"b".repeat(50)}`;
    const out = normalizeDescription(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("preserves fitting emoji under limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(150)}${fox}`;
    const out = normalizeDescription(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("sanitizes a lone surrogate without shortening the description", () => {
    const lone = `manifest ${String.fromCharCode(0xd800)} ${"a".repeat(300)}`;
    const out = normalizeDescription(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.length).toBe(lone.length);
    expect(out.endsWith("a".repeat(300))).toBe(true);
  });

  it("sanitizes lone surrogate without truncation when fitting", () => {
    const lone = `manifest ${String.fromCharCode(0xd800)} test`;
    const out = normalizeDescription(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("manifest \uFFFD test");
  });
});
