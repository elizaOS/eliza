/** Exercises Unicode-safe proactive activity previews with deterministic text fixtures. */

import { describe, expect, it } from "vitest";
import { formatProactiveMessageSummary } from "../../hooks/useActivityEvents";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
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

// Naive old implementations — kept only to prove they are ill-formed/over-length.
// If these ever become well-formed the test demonstrates the production fix is
// still needed.
function naiveActivitySummary(text: string): string {
  return text.trim().slice(0, 120) || "Proactive message";
}

describe("useActivityEvents formatProactiveMessageSummary — production seam", () => {
  it("keeps surrogate pairs intact at 120-char boundary (production well-formed, naive ill-formed)", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(119)}${fox}${"b".repeat(50)}`;
    const out = formatProactiveMessageSummary(input);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.length).toBe(119);
    expect(out).not.toContain("\uD83E");

    const naive = naiveActivitySummary(input);
    expect(isWellFormed(naive)).toBe(false);
    expect(naive.length).toBe(120);
    expect(naive.charCodeAt(119)).toBe(0xd83e);
  });

  it("trims whitespace and falls back to placeholder for empty", () => {
    expect(formatProactiveMessageSummary("   ")).toBe("Proactive message");
    expect(formatProactiveMessageSummary("  hello  ")).toBe("hello");
    expect(formatProactiveMessageSummary("\n\t  spaced \t text  ")).toBe(
      "spaced \t text",
    );
    // naive also trims but we test production seam
    const out = formatProactiveMessageSummary("  hello world  ");
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe("hello world");
  });

  it("sanitizes lone surrogates in activity summary and stays bounded", () => {
    const lone = `activity ${String.fromCharCode(0xd800)} message ${"x".repeat(200)}`;
    const out = formatProactiveMessageSummary(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(() => JSON.stringify({ summary: out })).not.toThrow();

    const naive = naiveActivitySummary(lone);
    expect(isWellFormed(naive)).toBe(false);
  });

  it("sweep 0..30 offsets at 120 stays well-formed", () => {
    const fox = "🦊";
    for (let off = 0; off < 30; off++) {
      const input = `${"a".repeat(110 + off)}${fox}${"b".repeat(50)}`;
      const out = formatProactiveMessageSummary(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(120);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });

  it("preserves fitting emoji at exactly 120 and below", () => {
    const fox = "🦊";
    const fitting = `${"a".repeat(118)}${fox}`; // 118 + 2 = 120
    expect(formatProactiveMessageSummary(fitting)).toBe(fitting);
    expect(isWellFormed(formatProactiveMessageSummary(fitting))).toBe(true);
    const short = `${"a".repeat(50)}${fox}`;
    expect(formatProactiveMessageSummary(short)).toBe(short);
  });

  it("JSON stringify never throws on truncated output", () => {
    const fox = "🦊";
    const lone = String.fromCharCode(0xd800);
    for (const input of [
      `${"a".repeat(119)}${fox}${"b".repeat(10)}`,
      `${lone}${"x".repeat(150)}`,
      `${fox.repeat(80)}`,
      "   ",
    ]) {
      const out = formatProactiveMessageSummary(input);
      expect(() => JSON.stringify({ text: out })).not.toThrow();
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(120);
    }
  });
});
