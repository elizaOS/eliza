/**
 * Behavioral regression for truncation maxLen — calls real truncateMessageForDisplay
 * Contract: surrogate-safe, well-formed, max<=0 → "", max handling, never split surrogate
 */
import { describe, it, expect } from "vitest";
import { truncateMessageForDisplay } from "../components/pages/browser-wallet-consent-format";
import { toWellFormedUnicode } from "@elizaos/core";

function isWellFormed(value: string): boolean {
  return typeof (value as any).isWellFormed === "function" ? (value as any).isWellFormed() : !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}

describe("truncateMessageForDisplay — behavioral maxLen & surrogate (real)", () => {
  it("max 0 → '' (not '… (5 more chars)')", () => {
    expect(truncateMessageForDisplay("hello", 0)).toBe("");
    expect(truncateMessageForDisplay("a".repeat(6100), 0)).toBe("");
    expect(truncateMessageForDisplay("👋hello", 0)).toBe("");
  });
  it("max 1 survives astral boundary as a single well-formed ellipsis", () => {
    const emoji = String.fromCharCode(0xD83D, 0xDE00);
    const out = truncateMessageForDisplay(`${emoji}${"a".repeat(10)}`, 1);
    expect(isWellFormed(out)).toBe(true);
    expect((out as any).isWellFormed()).toBe(true);
    expect(out).toBe("…");
    expect(out.length).toBe(1);
  });
  it("short input under max returns well-formed unchanged", () => {
    const text = "short message";
    expect(truncateMessageForDisplay(text, 240)).toBe(toWellFormedUnicode(text));
    expect(isWellFormed(truncateMessageForDisplay(text, 240))).toBe(true);
  });
  it("keeps surrogate pairs intact at 240 boundary with suffix", () => {
    const emoji = String.fromCharCode(0xD83D, 0xDE00);
    const text = `${"a".repeat(239)}${emoji}${"b".repeat(20)}`;
    const out = truncateMessageForDisplay(text, 240);
    expect(isWellFormed(out)).toBe(true);
    expect((out as any).isWellFormed()).toBe(true);
    expect(out).toContain("… (");
  });
  it("large 6100 with default max 240 is truncated and well-formed", () => {
    const out = truncateMessageForDisplay("a".repeat(6100), 240);
    expect(out.length).toBeGreaterThan(240);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toContain("more chars");
  });
  it("never emits lone surrogates at every boundary around 240", () => {
    const emoji = String.fromCharCode(0xD83E, 0xDD8A);
    for (let n = 0; n <= 245; n++) {
      const text = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
      const out = truncateMessageForDisplay(text, 240);
      expect(isWellFormed(out)).toBe(true);
      expect((out as any).isWellFormed()).toBe(true);
    }
  });
  it("sanitizes lone surrogates before truncation", () => {
    const lone = `msg ${String.fromCharCode(0xD800)} ${"x".repeat(300)}`;
    const out = truncateMessageForDisplay(lone, 240);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
  });
});
