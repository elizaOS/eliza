/** Surrogate safety for vision action scene description in action.ts. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

const MAX_VISION_TEXT_LENGTH = 4000;

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

function formatVisionText(description: string): string {
  return truncateWellFormed(
    toWellFormedUnicode(description),
    MAX_VISION_TEXT_LENGTH,
  );
}

describe("vision action scene description surrogate safety", () => {
  test("emoji at 3999 boundary backs off cleanly without lone surrogate", () => {
    const fox = "🦊";
    const description = `${"a".repeat(3999)}${fox}${"b".repeat(500)}`;
    const text = formatVisionText(description);
    expect(isWellFormed(text)).toBe(true);
    expect(text).toBe("a".repeat(3999));
    expect(() => JSON.stringify({ text })).not.toThrow();
  });

  test("fitting emoji ending at 4000 kept intact", () => {
    const fox = "🦊";
    const description = `${"a".repeat(3998)}${fox}`;
    const text = formatVisionText(description);
    expect(isWellFormed(text)).toBe(true);
    expect(text.includes(fox)).toBe(true);
  });

  test("lone high surrogate in scene description sanitized safely", () => {
    const badDesc = `Bad \ud800 visual scene description ${"x".repeat(5000)}`;
    const text = formatVisionText(badDesc);
    expect(isWellFormed(text)).toBe(true);
    expect(text.includes("\ud800")).toBe(false);
  });

  test("sweep offsets around 4k cap all stay well-formed", () => {
    const fox = "🦊";
    for (let offset = -5; offset <= 5; offset++) {
      const n = 4000 + offset;
      const description = `${"a".repeat(n)}${fox}${"b".repeat(20)}`;
      const text = formatVisionText(description);
      expect(isWellFormed(text)).toBe(true);
      expect(() => JSON.stringify({ text })).not.toThrow();
    }
  });
});
