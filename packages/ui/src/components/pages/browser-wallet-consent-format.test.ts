/**
 * Regression for browser-wallet-consent `truncateMessageForDisplay`
 * surrogate-safe truncation (stricter JSON wire safety).
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { truncateMessageForDisplay } from "./browser-wallet-consent-format";

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

describe("truncateMessageForDisplay well-formed", () => {
  it("keeps surrogate pairs intact at 240 boundary", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(239)}${emoji}${"b".repeat(20)}`;
    const out = truncateMessageForDisplay(text, 240);
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
    expect(out).toContain("… (");
    expect(out.startsWith("a".repeat(239))).toBe(true);
  });

  it("preserves fitting emoji under cap", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(238)}${emoji}`;
    const out = truncateMessageForDisplay(text, 240);
    expect(out).toBe(toWellFormedUnicode(text));
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate before truncation", () => {
    const lone = `msg ${String.fromCharCode(0xd800)} ${"x".repeat(300)}`;
    const out = truncateMessageForDisplay(lone, 240);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
  });

  it("sanitizes lone low surrogate before truncation", () => {
    const lone = `msg ${String.fromCharCode(0xdc00)} ${"x".repeat(300)}`;
    const out = truncateMessageForDisplay(lone, 240);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
  });

  it("returns short input well-formed unchanged", () => {
    const text = "short message";
    expect(truncateMessageForDisplay(text, 240)).toBe(text);
    expect(isWellFormed(truncateMessageForDisplay(text, 240))).toBe(true);
  });

  it("handles max=1 astral boundary to empty well-formed prefix", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${emoji}${"a".repeat(10)}`;
    const out = truncateMessageForDisplay(text, 1);
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
    expect(out.startsWith("… (")).toBe(true);
  });

  it("never emits lone surrogates at every boundary around 240", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    for (let n = 0; n <= 245; n++) {
      const text = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
      const out = truncateMessageForDisplay(text, 240);
      expect(isWellFormed(out)).toBe(true);
      expect(out.isWellFormed()).toBe(true);
    }
  });

  it("suffix counts wellFormed length not raw slice", () => {
    const lone = `${"a".repeat(239)}${String.fromCharCode(0xd800)}${"b".repeat(5)}`;
    const out = truncateMessageForDisplay(lone, 240);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toContain("more chars");
  });
});
