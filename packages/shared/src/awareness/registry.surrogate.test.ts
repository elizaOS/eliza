/**
 * Regression for the legacy `truncateSummaryLine` compatibility export. It
 * now preserves complete summaries while repairing malformed Unicode.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { normalizeSummaryLine } from "./registry";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  if (
    typeof (value as unknown as { isWellFormed?: () => boolean })
      .isWellFormed === "function"
  ) {
    return (value as unknown as { isWellFormed: () => boolean }).isWellFormed();
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

describe("normalizeSummaryLine well-formed", () => {
  it("keeps complete surrogate-pair text beyond the old boundary", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(77)}${emoji}${"b".repeat(20)}`;
    const out = normalizeSummaryLine(text);
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
    expect(out).toBe(text);
  });

  it("preserves fitting emoji under cap", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(78)}${emoji}`;
    const out = normalizeSummaryLine(text);
    expect(out).toBe(toWellFormedUnicode(text));
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(text);
  });

  it("sanitizes a lone high surrogate without shortening the text", () => {
    const lone = `msg ${String.fromCharCode(0xd800)} ${"x".repeat(100)}`;
    const out = normalizeSummaryLine(lone);
    expect(out).toContain("�");
    expect(out.length).toBe(lone.length);
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
  });

  it("sanitizes a lone low surrogate without shortening the text", () => {
    const lone = `msg ${String.fromCharCode(0xdc00)} ${"x".repeat(100)}`;
    const out = normalizeSummaryLine(lone);
    expect(out).toContain("�");
    expect(out.length).toBe(lone.length);
    expect(isWellFormed(out)).toBe(true);
  });

  it("returns short string well-formed unchanged", () => {
    const text = "short summary";
    expect(normalizeSummaryLine(text)).toBe(text);
    expect(isWellFormed(normalizeSummaryLine(text))).toBe(true);
  });

  it("handles astral at boundary with long text", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const long = `${"a".repeat(78)}${emoji}${"b".repeat(20)}`;
    const out = normalizeSummaryLine(long);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(long);
  });

  it("never emits lone surrogates at sweep around 80", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    for (let n = 0; n <= 90; n++) {
      const text = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
      const out = normalizeSummaryLine(text);
      expect(isWellFormed(out)).toBe(true);
      expect(out.isWellFormed()).toBe(true);
      expect(out).toBe(text);
    }
  });
});
