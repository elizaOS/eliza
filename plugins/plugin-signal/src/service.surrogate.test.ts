/** Surrogate safety for signal connector target description in service.ts. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

function formatTargetDescription(speakerName: string, text: string): string {
  return `${speakerName}: ${truncateWellFormed(toWellFormedUnicode(text), 120)}`;
}

describe("signal service target description surrogate safety", () => {
  test("emoji at 119 boundary backs off cleanly without lone surrogate", () => {
    const fox = "🦊";
    const text = `${"a".repeat(119)}${fox}${"b".repeat(50)}`;
    const desc = formatTargetDescription("Alice", text);
    expect(isWellFormed(desc)).toBe(true);
    expect(desc).toBe(`Alice: ${"a".repeat(119)}`);
    expect(() => JSON.stringify({ desc })).not.toThrow();
  });

  test("fitting emoji ending at 120 kept intact", () => {
    const fox = "🦊";
    const text = `${"a".repeat(118)}${fox}`;
    const desc = formatTargetDescription("Bob", text);
    expect(isWellFormed(desc)).toBe(true);
    expect(desc.includes(fox)).toBe(true);
  });

  test("lone high surrogate in recent text sanitized safely", () => {
    const badText = `Signal message with \ud800 corrupt surrogate ${"x".repeat(200)}`;
    const desc = formatTargetDescription("Charlie", badText);
    expect(isWellFormed(desc)).toBe(true);
    expect(desc.includes("\ud800")).toBe(false);
  });

  test("sweep offsets around 120 cap all stay well-formed", () => {
    const fox = "🦊";
    for (let offset = -5; offset <= 5; offset++) {
      const n = 120 + offset;
      const text = `${"a".repeat(n)}${fox}${"b".repeat(20)}`;
      const desc = formatTargetDescription("User", text);
      expect(isWellFormed(desc)).toBe(true);
      expect(() => JSON.stringify({ desc })).not.toThrow();
    }
  });
});
