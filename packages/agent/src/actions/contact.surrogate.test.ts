/** Surrogate safety for contact action message history truncation: msg.text must never emit lone surrogates. */
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function clampContactMessage(text: string, max = 200): string {
  return truncateWellFormed(toWellFormedUnicode(text), max);
}

describe("contact message history surrogate safety", () => {
  test("emoji at 199 boundary backs off to 199 without lone surrogate at 200 cap", () => {
    const input = `${"a".repeat(199)}🦊${"b".repeat(50)}`;
    const out = clampContactMessage(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(199);
    expect(() => JSON.stringify({ message: out })).not.toThrow();
    expect(out.endsWith("🦊")).toBe(false);
  });

  test("fitting emoji ending at 200 kept intact", () => {
    const input = `${"a".repeat(198)}🦊`;
    const out = clampContactMessage(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(200);
    expect(out.endsWith("🦊")).toBe(true);
  });

  test("short contact message with emoji passes through untouched", () => {
    const input = "Hey, let's catch up soon! 🦊";
    const out = clampContactMessage(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  test("lone high surrogate is sanitized before truncation", () => {
    const input = `bad \ud800 surrogate ${"x".repeat(250)}`;
    const out = clampContactMessage(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\ud800")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  test("sweep 195..205 emoji offsets at 200 cap all stay well-formed", () => {
    const fox = "🦊";
    for (let n = 195; n <= 205; n++) {
      const input = `${"a".repeat(n)}${fox}${"b".repeat(50)}`;
      const out = clampContactMessage(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(200);
      expect(() => JSON.stringify({ message: out })).not.toThrow();
    }
  });
});
