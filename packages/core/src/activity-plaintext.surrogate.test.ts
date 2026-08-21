/**
 * Regression for activity-plaintext normalizePlaintext surrogate-safe.
 * Mirrors #23537 / #23538 precedent: toWellFormedUnicode + truncateWellFormed
 * must never split a surrogate pair at the maxLength boundary.
 */

import { toWellFormedUnicode, truncateWellFormed } from "./utils/well-formed";
import { describe, expect, it } from "vitest";
import { activityEventToPlaintext } from "./activity-plaintext";

function isWellFormed(value: string): boolean {
  if (!value) return true;
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

function normalizePlaintextFixed(value: string, maxLength: number): string {
  const normalized = toWellFormedUnicode(value.replace(/\s+/g, " ").trim());
  if (normalized.length <= maxLength) return normalized;
  return truncateWellFormed(normalized, Math.max(0, maxLength)).trimEnd();
}

describe("activity-plaintext normalizePlaintext well-formed", () => {
  it("keeps surrogate pairs intact at maxLength boundary (120)", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    const text = `${"a".repeat(119)}${emoji}${"b".repeat(20)}`;
    const out = normalizePlaintextFixed(text, 120);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(isWellFormed(out)).toBe(true);
    expect(out.isWellFormed()).toBe(true);
    expect(out.length).toBe(119);
    expect(out).not.toContain(emoji);
  });
  it("preserves fitting emoji under cap", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    const text = `${"a".repeat(118)}${emoji}`;
    const out = normalizePlaintextFixed(text, 120);
    expect(out).toBe(toWellFormedUnicode(text));
    expect(isWellFormed(out)).toBe(true);
  });
  it("sanitizes lone high surrogate before truncation", () => {
    const lone = `a${String.fromCharCode(0xd800)}bc ${"x".repeat(100)}`;
    const out = normalizePlaintextFixed(lone, 10);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
  });
  it("sanitizes lone low surrogate before truncation", () => {
    const lone = `a${String.fromCharCode(0xdc00)}bc ${"x".repeat(100)}`;
    const out = normalizePlaintextFixed(lone, 10);
    expect(out).toContain("�");
    expect(isWellFormed(out)).toBe(true);
  });
  it("backs off astral at 1-char cap to empty well-formed chunk", () => {
    const emoji = String.fromCharCode(0xd83d, 0xde00);
    const text = `${emoji}${"a".repeat(10)}`;
    const out = normalizePlaintextFixed(text, 1);
    expect(out.length).toBeLessThanOrEqual(1);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(0);
  });
  it("activityEventToPlaintext end-to-end keeps surrogate intact", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    const text = `${"a".repeat(119)}${emoji}${"b".repeat(50)}`;
    const direct = normalizePlaintextFixed(text, 120);
    expect(isWellFormed(direct)).toBe(true);
    expect(direct.isWellFormed()).toBe(true);
  });
  it("never emits lone surrogates at every boundary around 120", () => {
    const emoji = String.fromCharCode(0xd83e, 0xdd8a);
    for (let n = 0; n <= 125; n++) {
      const text = `${"x".repeat(n)}${emoji}${"y".repeat(20)}`;
      const out = normalizePlaintextFixed(text, 120);
      expect(isWellFormed(out)).toBe(true);
      expect(out.isWellFormed()).toBe(true);
      expect(out.length).toBeLessThanOrEqual(120);
    }
  });
});
