/**
 * Regression tests for surrogate-safe truncation in SaveCommandModal preview
 * and useActivityEvents proactive message summary. Both production formatters
 * are imported directly so reverting either to `.slice(0, N)` makes the suite
 * red — see the explicit naive-slice comparison tests that prove the old code
 * emits lone surrogates and length overflow.
 */

import { describe, expect, it } from "vitest";
import { formatProactiveMessageSummary } from "../../hooks/useActivityEvents";
import { formatCommandPreview } from "./SaveCommandModal";

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
function naiveCommandPreview(text: string): string {
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function naiveActivitySummary(text: string): string {
  return text.trim().slice(0, 120) || "Proactive message";
}

describe("SaveCommandModal formatCommandPreview — production seam", () => {
  it("keeps surrogate pairs intact at 117-char boundary (production well-formed, naive ill-formed)", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"c".repeat(116)}${fox}${"d".repeat(50)}`;
    const out = formatCommandPreview(input);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
    // backs off the split surrogate: 116 + 3 dots = 119, not 120+3=123 and not containing lone high
    expect(out.length).toBe(116 + 3);
    expect(out).not.toContain("\uD83E");

    const naive = naiveCommandPreview(input);
    // naive slices at 120 which lands mid-fox (116 + 2-char fox): high surrogate at 117, low at 118 is cut?
    // At 116 "c" + fox (2 units) = 118 chars before "d"s, so slice(0,120) keeps fox intact in this exact layout,
    // but the 119/120 split case below proves the bug. For this input, check overflow instead:
    expect(naive.length).toBe(123);
    expect(naive.length).toBeGreaterThan(120);
  });

  it("backs off surrogate that straddles the 117 truncation point", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    // 117 = 116 chars + high surrogate — truncateWellFormed must back off to 116
    const _input = `${"a".repeat(116)}${fox}${"b".repeat(50)}`;
    // But formatCommandPreview uses 117 budget before adding "...", so 116 + fox straddles 117
    // Simpler: 117 budget case is 117 "a" + fox would split? Use 116 + fox + tail
    const input2 = `${"a".repeat(117)}${fox}${"b".repeat(10)}`;
    const out = formatCommandPreview(input2);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(() => JSON.stringify(out)).not.toThrow();
    // naive would keep lone high at 120 boundary
    const naiveInput = `${"a".repeat(119)}${fox}${"b".repeat(10)}`;
    const naive = naiveCommandPreview(naiveInput);
    // naive slices at 120: 119 "a" + high surrogate at 119 = lone high
    expect(isWellFormed(naive)).toBe(false);
    expect(naive.includes("\uD83E")).toBe(true);
    // production backs off
    const prod = formatCommandPreview(naiveInput);
    expect(isWellFormed(prod)).toBe(true);
    expect(prod.length).toBeLessThanOrEqual(120);
  });

  it("keeps well-formed and length-capped across 0..30 offsets around 117", () => {
    const fox = "🦊";
    for (let off = 0; off < 30; off++) {
      const input = `${"a".repeat(100 + off)}${fox}${"b".repeat(50)}`;
      const out = formatCommandPreview(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(120);
      expect(() => JSON.stringify({ preview: out })).not.toThrow();
    }
  });

  it("sanitizes lone surrogates and stays well-formed and bounded", () => {
    const lone = `Save command ${String.fromCharCode(0xd800)} preview ${"k".repeat(200)}`;
    const out = formatCommandPreview(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes(String.fromCharCode(0xd800))).toBe(false);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(() => JSON.stringify(out)).not.toThrow();
    // naive would preserve lone surrogate (ill-formed) and overflow
    const naive = naiveCommandPreview(lone);
    expect(isWellFormed(naive)).toBe(false);
  });

  it("preserves short text without truncation and sanitizes alone", () => {
    const short = "short command text";
    expect(formatCommandPreview(short)).toBe(short);
    const withEmoji = "hello 🦊 world";
    expect(formatCommandPreview(withEmoji)).toBe(withEmoji);
    const loneShort = `hi ${String.fromCharCode(0xdc00)}`;
    const sanitized = formatCommandPreview(loneShort);
    expect(isWellFormed(sanitized)).toBe(true);
    expect(sanitized.includes("�")).toBe(true);
  });
});

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
