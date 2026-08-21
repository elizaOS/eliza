/** Surrogate safety for misc-routes share ingest prompt truncation. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function sharePrompt(text: string): string {
  return `What are your thoughts on: ${truncateWellFormed(toWellFormedUnicode(text), 100)}`;
}

describe("misc-routes surrogate safety", () => {
  test("100 boundary backs off at surrogate without lone", () => {
    const fox = "🦊";
    const text = `${"a".repeat(99)}${fox}${"b".repeat(20)}`;
    const out = sharePrompt(text);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out.length).toBeLessThanOrEqual(
      "What are your thoughts on: ".length + 100,
    );
  });
  test("short text passthrough", () => {
    const out = sharePrompt("short share 🦊");
    expect(out).toBe(
      `What are your thoughts on: ${toWellFormedUnicode("short share 🦊")}`,
    );
    expect(isWellFormed(out)).toBe(true);
  });
  test("emoji at 99 fits", () => {
    const fox = "🦊";
    const text = `${"a".repeat(98)}${fox}tail`;
    const out = sharePrompt(text);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes(fox)).toBe(true);
  });
  test("lone surrogate sanitized", () => {
    const lone = `share ${String.fromCharCode(0xd800)} ${"x".repeat(200)}`;
    const out = sharePrompt(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });
  test("sweep offsets well-formed", () => {
    const fox = "🦊";
    for (let n = 95; n <= 105; n++) {
      const text = `${"a".repeat(n)}${fox}${"b".repeat(10)}`;
      const out = sharePrompt(text);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});
