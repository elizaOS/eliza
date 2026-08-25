/** Surrogate safety for inbox-routes lastMessageText truncation: must never emit lone surrogates. */
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

const INBOX_CHAT_PREVIEW_LENGTH = 140;

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function clampInboxPreview(
  text: string,
  max = INBOX_CHAT_PREVIEW_LENGTH,
): string {
  return truncateWellFormed(toWellFormedUnicode(text), max);
}

describe("inbox-routes lastMessageText surrogate safety", () => {
  test("emoji at 139 boundary backs off to 139 without lone surrogate at 140 cap", () => {
    const input = `${"a".repeat(139)}🦊${"b".repeat(50)}`;
    const out = clampInboxPreview(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(139);
    expect(() => JSON.stringify({ lastMessageText: out })).not.toThrow();
    expect(out.endsWith("🦊")).toBe(false);
  });

  test("fitting emoji ending at 140 kept intact", () => {
    const input = `${"a".repeat(138)}🦊`;
    const out = clampInboxPreview(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(140);
    expect(out.endsWith("🦊")).toBe(true);
  });

  test("short message with emoji passes through untouched", () => {
    const input = "Hey, check out this cute fox 🦊!";
    const out = clampInboxPreview(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  test("lone high surrogate is sanitized before truncation", () => {
    const input = `bad \ud800 surrogate ${"x".repeat(200)}`;
    const out = clampInboxPreview(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\ud800")).toBe(false);
    expect(out.length).toBeLessThanOrEqual(140);
  });

  test("sweep 135..145 emoji offsets at 140 cap all stay well-formed", () => {
    const fox = "🦊";
    for (let n = 135; n <= 145; n++) {
      const input = `${"a".repeat(n)}${fox}${"b".repeat(50)}`;
      const out = clampInboxPreview(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(140);
      expect(() => JSON.stringify({ lastMessageText: out })).not.toThrow();
    }
  });
});
