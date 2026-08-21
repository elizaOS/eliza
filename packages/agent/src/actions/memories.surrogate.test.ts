/**
 * Surrogate-safe truncation for memories action (300/120 caps).
 * Verifies caps never split an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function truncate300(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), 300);
}
function truncate120(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text ?? ""), 120);
}

function isWellFormed(s: string): boolean {
  const w = s as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(s) === s;
}

describe("memories surrogate handling", () => {
  it("300 backs off at surrogate (299+fox→299)", () => {
    const input = `${"a".repeat(299)}🦊${"b".repeat(20)}`;
    const out = truncate300(input);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out).toBe("a".repeat(299));
  });

  it("300 preserves fitting emoji (298+fox intact)", () => {
    const input = `${"a".repeat(298)}🦊`;
    const out = truncate300(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(`${"a".repeat(298)}🦊`);
  });

  it("120 backs off at surrogate (119+fox→119)", () => {
    const input = `${"a".repeat(119)}🦊${"b".repeat(20)}`;
    const out = truncate120(input);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out).toBe("a".repeat(119));
  });

  it("120 preserves fitting emoji (118+fox intact)", () => {
    const input = `${"a".repeat(118)}🦊`;
    const out = truncate120(input);
    expect(out).toBe(`${"a".repeat(118)}🦊`);
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `ok ${String.fromCharCode(0xd800)} text ${"a".repeat(300)}`;
    const out = truncate300(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes(String.fromCharCode(0xd800))).toBe(false);
  });

  it("sanitizes lone low surrogate", () => {
    const lone = `ok ${String.fromCharCode(0xdc00)} text ${"a".repeat(300)}`;
    const out = truncate300(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("short text passthrough remains well-formed", () => {
    const text = "short memory";
    expect(truncate300(text)).toBe(text);
    expect(isWellFormed(truncate300(text))).toBe(true);
    expect(isWellFormed(truncate120(text))).toBe(true);
  });

  it("sweep 0..30 offsets at 300 and 120 all well-formed", () => {
    const fox = "🦊";
    for (let n = 0; n <= 30; n++) {
      const text300 = `${"a".repeat(n)}${fox}${"b".repeat(400)}`;
      const out300 = truncate300(text300);
      expect(isWellFormed(out300)).toBe(true);
      expect(out300.length).toBeLessThanOrEqual(300);
      expect(() => JSON.stringify(out300)).not.toThrow();
      const text120 = `${"a".repeat(n)}${fox}${"b".repeat(400)}`;
      const out120 = truncate120(text120);
      expect(isWellFormed(out120)).toBe(true);
      expect(out120.length).toBeLessThanOrEqual(120);
    }
  });

  it("sweep lone surrogate at 300 stays well-formed", () => {
    for (let n = 0; n <= 30; n++) {
      const text = `${"a".repeat(n)}${String.fromCharCode(0xd800)}${"b".repeat(400)}`;
      const out = truncate300(text);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(300);
    }
  });
});
