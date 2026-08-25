/**
 * Surrogate-safe truncation for reporter truncateText.
 * Verifies the 420-char cap never splits an astral surrogate pair and sanitizes lone surrogates.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { truncateText } from "./reporter";

describe("truncateText surrogate safety", () => {
  const isWellFormed = (s: string): boolean => {
    const w = s as unknown as { isWellFormed?: () => boolean };
    if (typeof w.isWellFormed === "function") return w.isWellFormed();
    return toWellFormedUnicode(s) === s;
  };

  it("backs off when truncation would split a surrogate pair at 420", () => {
    const input = `${"a".repeat(419)}🦊${"b".repeat(20)}`;
    const out = truncateText(input, 420);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(420);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("preserves a fitting astral emoji at the cap (a*418+🦊 at 420)", () => {
    const input = `${"a".repeat(418)}🦊`;
    const out = truncateText(input, 420);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(toWellFormedUnicode(input));
  });

  it("preserves well-formed text under cap", () => {
    const input = `${"a".repeat(100)}🦊`;
    const out = truncateText(input, 420);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(toWellFormedUnicode(input));
  });

  it("sanitizes lone high surrogate", () => {
    const input = `ok \ud800 end ${"x".repeat(500)}`;
    const out = truncateText(input, 420);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes("\ud800")).toBe(false);
  });

  it("sanitizes lone low surrogate", () => {
    const input = `ok \udc00 end ${"x".repeat(500)}`;
    const out = truncateText(input, 420);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("stays well-formed across sweep of offsets", () => {
    for (let offset = 0; offset <= 30; offset++) {
      const input = `${"a".repeat(offset)}🦊${"b".repeat(500)}`;
      const out = truncateText(input, 420);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(420);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });

  it("returns well-formed when under cap with lone surrogate", () => {
    const input = "ok \ud800 end";
    const out = truncateText(input, 420);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("caps at 420 with 419 content + ellipsis for overflow", () => {
    const input = "a".repeat(500);
    const out = truncateText(input, 420);
    expect(out.length).toBe(420);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1).length).toBe(419);
  });

  it("handles non-string values via JSON.stringify and stays well-formed", () => {
    const obj = { text: `${"a".repeat(418)}🦊` };
    const out = truncateText(obj, 420);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(420);
  });
});
