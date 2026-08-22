/**
 * Verifies form restore responses preserve complete Unicode-safe content.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function normalizeRestoreResponse(text: string): string {
  return toWellFormedUnicode(text);
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

describe("form restore response normalization", () => {
  it("preserves content across the former 4000-character boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(3_999)}${fox}${"b".repeat(50)}`;
    const out = normalizeRestoreResponse(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("preserves fitting emoji under limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(3000)}${fox}`;
    const out = normalizeRestoreResponse(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("sanitizes a lone surrogate without dropping the tail", () => {
    const lone = `form ${String.fromCharCode(0xd800)} ${"a".repeat(5000)}`;
    const out = normalizeRestoreResponse(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.endsWith("a".repeat(5000))).toBe(true);
  });

  it("sanitizes a fitting lone surrogate", () => {
    const lone = `form ${String.fromCharCode(0xd800)} ok`;
    const out = normalizeRestoreResponse(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("form \uFFFD ok");
  });
});
