/**
 * Surrogate-safe truncation for trajectory-internals (100000/500 caps).
 * Verifies clamps never split an astral surrogate pair.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const RESPONSE_LIMIT = 100_000;
const EXCHANGE_LIMIT = 500;

function clampResponse(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), RESPONSE_LIMIT);
}

function clampExchange(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), EXCHANGE_LIMIT);
}

function isWellFormed(value: string): boolean {
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

describe("trajectory-internals well-formed", () => {
  it("100k backs off astral at boundary (99999+fox->99999)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(99_999)}${fox}${"b".repeat(20)}`;
    const out = clampResponse(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(99_999);
    expect(out).toBe("a".repeat(99_999));
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("100k preserves fitting astral (99998+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(99_998)}${fox}`;
    const out = clampResponse(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(100_000);
  });

  it("500 backs off astral at boundary (499+fox->499)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(499)}${fox}${"b".repeat(20)}`;
    const out = clampExchange(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(499);
    expect(out).toBe("a".repeat(499));
  });

  it("500 preserves fitting astral (498+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(498)}${fox}`;
    const out = clampExchange(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(500);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `hi ${String.fromCharCode(0xd800)} world ${"a".repeat(600)}`;
    const out = clampExchange(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("sanitizes lone low surrogate", () => {
    const lone = `hi ${String.fromCharCode(0xdc00)} world ${"a".repeat(600)}`;
    const out = clampResponse(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("short passthrough remains well-formed", () => {
    expect(clampResponse("short")).toBe("short");
    expect(clampExchange("short")).toBe("short");
    expect(isWellFormed(clampResponse("short"))).toBe(true);
  });

  it("sweep 0..30 at 500 well-formed and JSON-safe", () => {
    const fox = "🦊";
    for (let n = 0; n <= 30; n++) {
      const input = `${"a".repeat(470 + n)}${fox}${"b".repeat(40)}`;
      const out = clampExchange(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(500);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});
