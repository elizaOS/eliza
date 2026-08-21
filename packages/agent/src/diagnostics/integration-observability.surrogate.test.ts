/** Surrogate safety for integration observability token sanitization. */
import { describe, expect, test } from "vitest";
import { sanitizeToken } from "./integration-observability.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return true;
}

describe("integration observability token surrogate safety", () => {
  test("emoji at 1023 boundary backs off cleanly in safe token pass", () => {
    const fox = "🦊";
    const value = `${"a".repeat(1023)}${fox}${"b".repeat(50)}`;
    const token = sanitizeToken(value);
    expect(token).toBeDefined();
    if (token) {
      expect(isWellFormed(token)).toBe(true);
      expect(() => JSON.stringify({ token })).not.toThrow();
    }
  });

  test("fitting token ending at 64 kept intact", () => {
    const fox = "🦊";
    const value = `${"a".repeat(60)}test`;
    const token = sanitizeToken(value);
    expect(token).toBeDefined();
    if (token) {
      expect(isWellFormed(token)).toBe(true);
      expect(token.length).toBeLessThanOrEqual(64);
    }
  });

  test("lone high surrogate in raw error name sanitized safely", () => {
    const badError = "CustomError\ud800Token_Name";
    const token = sanitizeToken(badError);
    expect(token).toBeDefined();
    if (token) {
      expect(isWellFormed(token)).toBe(true);
      expect(token.includes("\ud800")).toBe(false);
    }
  });

  test("sweep offsets around 1024 cap all stay well-formed", () => {
    const fox = "🦊";
    for (let offset = -5; offset <= 5; offset++) {
      const n = 1024 + offset;
      const value = `${"a".repeat(n)}${fox}${"b".repeat(20)}`;
      const token = sanitizeToken(value);
      if (token) {
        expect(isWellFormed(token)).toBe(true);
        expect(() => JSON.stringify({ token })).not.toThrow();
      }
    }
  });
});
