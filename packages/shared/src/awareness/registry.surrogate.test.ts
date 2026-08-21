/**
 * Regression for awareness `truncateSummaryLine` surrogate-safe
 * truncation (80 cap). Mirrors #23565 precedent.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { truncateSummaryLine } from "./registry";

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

describe("truncateSummaryLine well-formed", () => {
  it("keeps surrogate pairs intact at 80 boundary", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(77)}${emoji}${"b".repeat(20)}`;
    const out = truncateSummaryLine(text);
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it("preserves fitting emoji under cap", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(78)}${emoji}`;
    const out = truncateSummaryLine(text);
    expect(out).toBe(toWellFormedUnicode(text));
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it("sanitizes lone high surrogate before truncation", () => {
    const lone = `msg ${String.fromCharCode(0xd800)} ${"x".repeat(100)}`;
    const out = truncateSummaryLine(lone);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
  });

  it("sanitizes lone low surrogate before truncation", () => {
    const lone = `msg ${String.fromCharCode(0xdc00)} ${"x".repeat(100)}`;
    const out = truncateSummaryLine(lone);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
  });

  it("returns short string well-formed unchanged", () => {
    const text = "short summary";
    expect(truncateSummaryLine(text)).toBe(text);
    expect(isWellFormed(truncateSummaryLine(text))).toBe(true);
  });

  it("handles astral at boundary with long text", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const long = `${"a".repeat(78)}${emoji}${"b".repeat(20)}`;
    const out = truncateSummaryLine(long);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it("never emits lone surrogates at sweep around 80", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    for (let n = 0; n <= 90; n++) {
      const text = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
      const out = truncateSummaryLine(text);
      expect(isWellFormed(out)).toBe(true);
      expect(out.isWellFormed()).toBe(true);
      expect(out.length).toBeLessThanOrEqual(80);
    }
  });
});
