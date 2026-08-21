/**
 * Regression for chat text helpers surrogate-safe truncation (100_000).
 * Mirrors parse-action-block truncation: toWellFormedUnicode + truncateWellFormed
 * must never split a surrogate pair at the 100k boundary.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const LIMIT = 100_000;

function clampChatText(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), LIMIT);
}

function isWellFormed(value: string): boolean {
  const w = value as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

describe("chat-text-helpers well-formed", () => {
  it("backs off astral at 100k boundary (99999+fox->99999)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(99_999)}${fox}${"b".repeat(20)}`;
    const out = clampChatText(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(99_999);
    expect(out).toBe("a".repeat(99_999));
  });

  it("preserves fitting astral at 100k (99998+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(99_998)}${fox}`;
    const out = clampChatText(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(100_000);
  });

  it("short passthrough", () => {
    expect(clampChatText("short hello")).toBe("short hello");
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `hi ${String.fromCharCode(0xd800)} world`;
    const out = clampChatText(`${lone}${"x".repeat(100_010)}`);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("sanitizes lone low surrogate", () => {
    const lone = `hi ${String.fromCharCode(0xdc00)} world`;
    const out = clampChatText(`${lone}${"x".repeat(100_010)}`);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("sweep around 100k well-formed", () => {
    const fox = "🦊";
    for (let n = 99_985; n <= 100_015; n++) {
      const input = `${"x".repeat(n)}${fox}${"y".repeat(20)}`;
      const out = clampChatText(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(LIMIT);
    }
  });

  it("JSON.stringify no throw on truncated output", () => {
    const fox = "🦊";
    const input = `${"a".repeat(99_999)}${fox}${"b".repeat(20)}`;
    const out = clampChatText(input);
    expect(() => JSON.stringify({ text: out })).not.toThrow();
    expect(isWellFormed(JSON.stringify({ text: out }))).toBe(true);
  });
});
