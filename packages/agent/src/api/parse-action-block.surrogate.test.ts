/**
 * Surrogate-safe truncation for parse-action-block (100k safeText).
 * Mirrors the S-Tier well-formed helpers used in parse-action-block.ts.
 */
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function safeText(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), 100_000);
}

function isWellFormed(value: string): boolean {
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

describe("parse-action-block surrogate safety", () => {
  it("backs off astral at 100k: 99999+'🦊'+tail → 99999 well-formed", () => {
    const input = `${"a".repeat(99_999)}🦊${"b".repeat(20)}`;
    const out = safeText(input);
    expect(out.length).toBe(99_999);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("keeps fitting emoji exactly at 100k: 99998+'🦊' → 100000 well-formed", () => {
    const input = `${"a".repeat(99_998)}🦊`;
    const out = safeText(input);
    expect(out.length).toBe(100_000);
    expect(out).toBe(input);
    expect(isWellFormed(out)).toBe(true);
  });

  it("passes short text through unchanged well-formed", () => {
    const input = "hello 🦊 world";
    const out = safeText(input);
    expect(out).toBe(toWellFormedUnicode(input));
    expect(isWellFormed(out)).toBe(true);
  });

  it("sanitizes lone high surrogate \\ud800 → � at 100k", () => {
    const _input = `${"a".repeat(10)}\ud800${"b".repeat(10)}`;
    const raw = "a".repeat(10) + String.fromCharCode(0xd800) + "b".repeat(10);
    const out = safeText(raw);
    expect(isWellFormed(out)).toBe(true);
    expect(out).not.toContain(String.fromCharCode(0xd800));
    expect(out).toContain("�");
  });

  it("sanitizes lone low surrogate \\udc00 → � at 100k", () => {
    const raw = "a".repeat(10) + String.fromCharCode(0xdc00) + "b".repeat(10);
    const out = safeText(raw);
    expect(isWellFormed(out)).toBe(true);
    expect(out).not.toContain(String.fromCharCode(0xdc00));
    expect(out).toContain("�");
  });

  it("sweep 0..30 at 100k: each n+'🦊'+tail → well-formed no throw", () => {
    for (let n = 0; n <= 30; n++) {
      const input = `${"a".repeat(99_970 + n)}🦊${"x".repeat(50)}`;
      const out = safeText(input);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
      expect(out.length).toBeLessThanOrEqual(100_000);
    }
  });

  it("JSON.stringify never throws for truncated surrogate text", () => {
    const input = `${"a".repeat(99_999)}🦊 tail`;
    const out = safeText(input);
    expect(() => JSON.stringify({ text: out })).not.toThrow();
    expect(isWellFormed(JSON.stringify({ text: out }))).toBe(true);
  });
});
