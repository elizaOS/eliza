/**
 * Regression for browser-wallet-consent `truncateMessageForDisplay`
 * surrogate-safe truncation (stricter JSON wire safety).
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { truncateMessageForDisplay } from "./browser-wallet-consent-format";

function expectWellFormed(value: string): void {
  expect(value).toBe(toWellFormedUnicode(value));
}

function expectDetailedPreview(
  source: string,
  preview: string,
  max: number,
): void {
  expect(preview.length).toBeLessThanOrEqual(max);
  expectWellFormed(preview);
  const match = /^(.*)… \((\d+) more chars\)$/s.exec(preview);
  expect(match).not.toBeNull();
  if (!match) return;
  expect(match[1].length + Number(match[2])).toBe(
    toWellFormedUnicode(source).length,
  );
}

describe("truncateMessageForDisplay well-formed", () => {
  it("keeps surrogate pairs intact at 240 boundary", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(239)}${emoji}${"b".repeat(20)}`;
    const out = truncateMessageForDisplay(text, 240);
    expectDetailedPreview(text, out, 240);
  });

  it("preserves fitting emoji under cap", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(238)}${emoji}`;
    const out = truncateMessageForDisplay(text, 240);
    expect(out).toBe(toWellFormedUnicode(text));
    expectWellFormed(out);
  });

  it("sanitizes lone high surrogate before truncation", () => {
    const lone = `msg ${String.fromCharCode(0xd800)} ${"x".repeat(300)}`;
    const out = truncateMessageForDisplay(lone, 240);
    expect(out).toContain("�");
    expectDetailedPreview(lone, out, 240);
  });

  it("sanitizes lone low surrogate before truncation", () => {
    const lone = `msg ${String.fromCharCode(0xdc00)} ${"x".repeat(300)}`;
    const out = truncateMessageForDisplay(lone, 240);
    expect(out).toContain("�");
    expectDetailedPreview(lone, out, 240);
  });

  it("returns short input well-formed unchanged", () => {
    const text = "short message";
    expect(truncateMessageForDisplay(text, 240)).toBe(text);
    expectWellFormed(truncateMessageForDisplay(text, 240));
  });

  it("handles max=1 astral boundary as a single well-formed ellipsis", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${emoji}${"a".repeat(10)}`;
    const out = truncateMessageForDisplay(text, 1);
    expectWellFormed(out);
    // max===1 cannot hold the "… (N more chars)" suffix; cap is a hard "…".
    expect(out).toBe("…");
    expect(out.length).toBe(1);
  });

  it("uses a prefix plus ellipsis when the detailed suffix cannot fit", () => {
    expect(truncateMessageForDisplay("abcdefgh", 2)).toBe("a…");
    expect(truncateMessageForDisplay("😀abcdefgh", 2)).toBe("…");
    expect(truncateMessageForDisplay("a".repeat(110), 18)).toBe(
      `${"a".repeat(17)}…`,
    );
  });

  it("max<=0 returns empty rather than a suffix-only preview", () => {
    expect(truncateMessageForDisplay("hello", 0)).toBe("");
    expect(truncateMessageForDisplay("a".repeat(100), 0)).toBe("");
    expect(truncateMessageForDisplay("👋hello", -1)).toBe("");
  });

  it("keeps the complete output bounded and well-formed around every boundary", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    for (let n = 1; n <= 245; n++) {
      const text = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
      const max = Math.max(1, n - 5);
      const out = truncateMessageForDisplay(text, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expectWellFormed(out);
    }
  });

  it("keeps the detailed suffix inside the cap and counts the actual omitted text", () => {
    const lone = `${"a".repeat(239)}${String.fromCharCode(0xd800)}${"b".repeat(5)}`;
    const out = truncateMessageForDisplay(lone, 240);
    expectDetailedPreview(lone, out, 240);
  });

  it("counts from the surrogate-safe prefix after the cut backs up", () => {
    const text = `${"a".repeat(222)}😀${"b".repeat(38)}`;
    const out = truncateMessageForDisplay(text, 240);
    expectDetailedPreview(text, out, 240);
    expect(out).toBe(`${"a".repeat(222)}… (40 more chars)`);
    expect(out.length).toBe(239);
  });

  it("stabilizes suffix width when the omission count gains a digit", () => {
    const text = "a".repeat(110);
    const out = truncateMessageForDisplay(text, 20);
    expectDetailedPreview(text, out, 20);
    expect(out).toBe("aa… (108 more chars)");
  });

  it("keeps a large default preview within the advertised 240-character budget", () => {
    const text = "a".repeat(6000);
    const out = truncateMessageForDisplay(text);
    expectDetailedPreview(text, out, 240);
    expect(out.length).toBe(240);
    expect(truncateMessageForDisplay(text)).toBe(out);
  });
});
