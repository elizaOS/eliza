/**
 * Regression for complete computeruse terminal output Unicode safety.
 */

import { describe, expect, it } from "vitest";
import { normalizeOutput } from "./terminal.js";

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

describe("computeruse terminal output well-formed", () => {
  it("keeps complete output across the former 5000-char boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(4999)}${fox}${"b".repeat(50)}`;
    const out = normalizeOutput(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("preserves fitting emoji under limit", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(4000)}${fox}`;
    const out = normalizeOutput(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  it("sanitizes a lone surrogate without losing the remaining output", () => {
    const lone = `term ${String.fromCharCode(0xd800)} ${"a".repeat(6000)}`;
    const out = normalizeOutput(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\uFFFD")).toBe(true);
    expect(out.endsWith("a".repeat(6000))).toBe(true);
  });

  it("sanitizes a lone surrogate in short output", () => {
    const lone = `term ${String.fromCharCode(0xd800)} ok`;
    const out = normalizeOutput(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("term \uFFFD ok");
  });
});
