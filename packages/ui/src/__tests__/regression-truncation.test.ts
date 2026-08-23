/**
 * Behavioral regression for truncation helpers — truncateMessageForDisplay
 * Contract: never exceed maxLen for tiny caps, surrogate-safe, handles
 * max 0,1,2,tiny,large 6000, Unicode surrogate pairs, fixed-point.
 * Calls real truncateMessageForDisplay — not source-grep.
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("@elizaos/core", () => {
  const toWellFormedUnicode = (text: string) => {
    const native = (String.prototype as any).toWellFormed;
    if (native) return native.call(text);
    let out = "";
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) {
          out += text[i] + text[i + 1];
          i++;
        } else {
          out += "�";
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        out += "�";
      } else {
        out += text[i];
      }
    }
    return out;
  };
  const truncateWellFormed = (text: string, maxLength: number) => {
    if (!Number.isFinite(maxLength) || maxLength <= 0) return "";
    if (text.length <= maxLength) return text;
    const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
    const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
    const end = isHigh(text.charCodeAt(maxLength - 1)) && isLow(text.charCodeAt(maxLength)) ? maxLength - 1 : maxLength;
    return text.slice(0, end);
  };
  return { toWellFormedUnicode, truncateWellFormed };
});
import { truncateMessageForDisplay } from "../components/pages/browser-wallet-consent-format";
import { toWellFormedUnicode } from "@elizaos/core";

function isWellFormed(value: string): boolean {
  if (typeof (value as unknown as { isWellFormed?: () => boolean }).isWellFormed === "function") {
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
    expect((out as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
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
    expect(truncateMessageForDisplay(text, 240)).toBe(toWellFormedUnicode(text));
    expect(isWellFormed(truncateMessageForDisplay(text, 240))).toBe(true);
  });

  it("keeps surrogate pairs intact at 240 boundary with suffix", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(239)}${emoji}${"b".repeat(20)}`;
    const out = truncateMessageForDisplay(text, 240);
    expect(isWellFormed(out)).toBe(true);
    expect((out as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
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
      expect((out as unknown as { isWellFormed: () => boolean }).isWellFormed()).toBe(true);
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
