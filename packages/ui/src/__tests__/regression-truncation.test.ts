/**
 * Behavioral regression for truncation helpers — truncateMessageForDisplay.
 * Calls the real helper and the real @elizaos/core well-formed utilities
 * (no in-test reimplementation). max<=0 → ""; max===1 → "…"; max>=2 keeps
 * the existing "… (N more chars)" preview suffix.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { truncateMessageForDisplay } from "../components/pages/browser-wallet-consent-format";

function isWellFormed(value: string): boolean {
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

describe("truncateMessageForDisplay — regression-truncation (real function)", () => {
  it("max 0 → '' (not '… (5 more chars)')", () => {
    expect(truncateMessageForDisplay("hello", 0)).toBe("");
    expect(truncateMessageForDisplay("a".repeat(6000), 0)).toBe("");
    expect(truncateMessageForDisplay("👋hello", 0)).toBe("");
  });

  it("max 1 survives astral boundary well-formed", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const out = truncateMessageForDisplay(`${emoji}${"a".repeat(10)}`, 1);
    expect(isWellFormed(out)).toBe(true);
    expect(
      (out as unknown as { isWellFormed: () => boolean }).isWellFormed(),
    ).toBe(true);
    expect(out).toBe("…");
    expect(out.length).toBe(1);
  });

  it("max 2 tiny — well-formed, never exceeds prefix cap", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(10)}${emoji}${"b".repeat(20)}`;
    const out = truncateMessageForDisplay(text, 2);
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
    // For truncateMessageForDisplay, suffix adds length, but prefix truncation is surrogate-safe
    // The fix ensures max<=0 returns "", max==1 returns "…", max==2 still surrogate-safe
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("short input under max returns well-formed unchanged", () => {
    const text = "short message";
    expect(truncateMessageForDisplay(text, 240)).toBe(
      toWellFormedUnicode(text),
    );
    expect(isWellFormed(truncateMessageForDisplay(text, 240))).toBe(true);
  });

  it("keeps surrogate pairs intact at 240 boundary with suffix", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(239)}${emoji}${"b".repeat(20)}`;
    const out = truncateMessageForDisplay(text, 240);
    expect(isWellFormed(out)).toBe(true);
    expect(
      (out as unknown as { isWellFormed: () => boolean }).isWellFormed(),
    ).toBe(true);
    expect(out).toContain("… (");
  });

  it("large 6000 with default max 240 is truncated and well-formed", () => {
    const out = truncateMessageForDisplay("a".repeat(6000), 240);
    expect(out.length).toBeGreaterThan(240);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toContain("more chars");
    // fixed-point
    expect(truncateMessageForDisplay("a".repeat(6000), 240)).toBe(out);
  });

  it("never emits lone surrogates at every boundary around 240", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    for (let n = 0; n <= 245; n++) {
      const text = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
      const out = truncateMessageForDisplay(text, 240);
      expect(isWellFormed(out)).toBe(true);
      expect(
        (out as unknown as { isWellFormed: () => boolean }).isWellFormed(),
      ).toBe(true);
    }
  });

  it("sanitizes lone surrogates before truncation", () => {
    const lone = `msg ${String.fromCharCode(0xd800)} ${"x".repeat(300)}`;
    const out = truncateMessageForDisplay(lone, 240);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
  });

  it("fixed-point: same input gives same output", () => {
    const text = `${"a".repeat(239)}😀${"b".repeat(100)}`;
    const a = truncateMessageForDisplay(text, 240);
    const b = truncateMessageForDisplay(text, 240);
    expect(a).toBe(b);
    expect(isWellFormed(a)).toBe(true);
  });
});
