/** Surrogate safety for chat-routes sanitizeActionResultValue string truncation: must never emit lone surrogates. */
import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function sanitizeActionResultValueString(value: string): string {
  const wellFormed = toWellFormedUnicode(value);
  return wellFormed.length > 1000
    ? `${truncateWellFormed(wellFormed, 997)}...`
    : wellFormed;
}

describe("chat-routes sanitizeActionResultValue surrogate safety", () => {
  test("emoji at 996 boundary backs off to 996 without lone surrogate at 997 cap", () => {
    const input = `${"a".repeat(996)}🦊${"b".repeat(50)}`;
    const out = sanitizeActionResultValueString(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBe(999); // 996 + 3
    expect(() => JSON.stringify({ result: out })).not.toThrow();
  });

  test("fitting emoji ending at 997 kept intact with ellipsis", () => {
    const input = `${"a".repeat(995)}🦊${"b".repeat(50)}`;
    const out = sanitizeActionResultValueString(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBe(1000); // 997 + 3
    expect(out.slice(0, 997).endsWith("🦊")).toBe(true);
  });

  test("short action result string with emoji passes through untouched", () => {
    const input = "Action completed successfully 🦊";
    const out = sanitizeActionResultValueString(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
  });

  test("lone high surrogate is sanitized before truncation", () => {
    const input = `bad \ud800 surrogate ${"x".repeat(1200)}`;
    const out = sanitizeActionResultValueString(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("\ud800")).toBe(false);
    expect(out.endsWith("...")).toBe(true);
  });

  test("sweep 990..1005 emoji offsets all stay well-formed with ellipsis", () => {
    const fox = "🦊";
    for (let n = 990; n <= 1005; n++) {
      const input = `${"a".repeat(n)}${fox}${"b".repeat(50)}`;
      const out = sanitizeActionResultValueString(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(1000);
      expect(() => JSON.stringify({ result: out })).not.toThrow();
    }
  });
});
