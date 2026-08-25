/**
 * Regression for browser receipt `renderReceiptValue` surrogate-safe
 * truncation (200 cap). Mirrors #23565 precedent.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  renderReceiptValue,
  summarizeBrowserSessionReceipt,
} from "./browser-session-policy";

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

describe("renderReceiptValue well-formed", () => {
  it("keeps surrogate pairs intact at 200 boundary (string)", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(199)}${emoji}${"b".repeat(20)}`;
    const out = renderReceiptValue(text);
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.startsWith("a".repeat(199))).toBe(true);
  });

  it("preserves fitting emoji under cap", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${"a".repeat(198)}${emoji}`;
    const out = renderReceiptValue(text);
    expect(out).toBe(toWellFormedUnicode(text));
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate before truncation", () => {
    const lone = `val ${String.fromCharCode(0xd800)} ${"x".repeat(250)}`;
    const out = renderReceiptValue(lone);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
  });

  it("sanitizes lone low surrogate before truncation", () => {
    const lone = `val ${String.fromCharCode(0xdc00)} ${"x".repeat(250)}`;
    const out = renderReceiptValue(lone);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
  });

  it("returns short string well-formed unchanged", () => {
    const text = "short receipt";
    expect(renderReceiptValue(text)).toBe(text);
    expect(isWellFormed(renderReceiptValue(text))).toBe(true);
  });

  it("handles serialized object with emoji at 200", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    const obj = { data: `${"a".repeat(190)}${emoji}${"b".repeat(30)}` };
    const out = renderReceiptValue(obj);
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });

  it("never emits lone surrogates at sweep around 200", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    for (let n = 0; n <= 210; n++) {
      const text = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
      const out = renderReceiptValue(text);
      expect(isWellFormed(out)).toBe(true);
      expect(out.isWellFormed()).toBe(true);
    }
  });

  it("summarizeBrowserSessionReceipt wrapper stays well-formed", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const session = {
      result: { ok: `${"a".repeat(199)}${emoji}tail` },
    } as unknown as Parameters<typeof summarizeBrowserSessionReceipt>[0];
    const entries = summarizeBrowserSessionReceipt(session);
    expect(entries[0].value).toContain("…");
    expect(isWellFormed(entries[0].value)).toBe(true);
  });
});
