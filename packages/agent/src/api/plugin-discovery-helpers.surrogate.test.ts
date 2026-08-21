/** Surrogate safety for maskValue in plugin-discovery-helpers. */
import { describe, expect, test } from "vitest";
import { maskValue } from "./plugin-discovery-helpers.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

describe("plugin-discovery-helpers maskValue surrogate safety", () => {
  test("emoji at head 4 boundary backs off without lone surrogate", () => {
    const fox = "🦊";
    const input = `abc${fox}long_secret_suffix`;
    const masked = maskValue(input);
    expect(isWellFormed(masked)).toBe(true);
    expect(masked.startsWith("abc...")).toBe(true);
    expect(() => JSON.stringify({ masked })).not.toThrow();
  });

  test("emoji at tail -4 boundary backs off without lone surrogate", () => {
    const fox = "🦊";
    const input = `prefix_long_secret_abc${fox}`;
    const masked = maskValue(input);
    expect(isWellFormed(masked)).toBe(true);
    expect(masked.endsWith(fox)).toBe(true);
    expect(() => JSON.stringify({ masked })).not.toThrow();
  });

  test("short value returns asterisks", () => {
    expect(maskValue("short")).toBe("****");
  });

  test("lone high surrogate in sensitive value is sanitized", () => {
    const badInput = "bad \ud800 secret string value 123456";
    const masked = maskValue(badInput);
    expect(isWellFormed(masked)).toBe(true);
    expect(masked.includes("\ud800")).toBe(false);
  });

  test("sweep offsets for masked secrets all stay well-formed", () => {
    const fox = "🦊";
    for (let n = 5; n <= 15; n++) {
      const secret = `${"a".repeat(n)}${fox}${"b".repeat(n)}`;
      const masked = maskValue(secret);
      expect(isWellFormed(masked)).toBe(true);
      expect(() => JSON.stringify({ masked })).not.toThrow();
    }
  });
});
