/**
 * Regression for remote-capability-cloud-sandbox surrogate-safe truncation (500).
 * Mirrors #23536: clamp at 500 must never split an astral pair and must
 * sanitize lone surrogates before provider wire / trajectory / error text.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

const AVAILABILITY_LIMIT = 500;

function clampAvailability(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), AVAILABILITY_LIMIT);
}

function isWellFormed(v: string): boolean {
  const maybe = v as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(v) === v;
}

describe("remote-capability-cloud-sandbox well-formed", () => {
  it("backs off astral at 500 boundary (499+fox->499)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(499)}${fox}${"b".repeat(20)}`;
    const out = clampAvailability(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(499);
    expect(out).toBe("a".repeat(499));
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("preserves fitting astral at 500 (498+fox intact)", () => {
    const fox = "🦊";
    const input = `${"a".repeat(498)}${fox}`;
    const out = clampAvailability(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out).toBe(input);
    expect(out.length).toBe(500);
  });

  it("short passthrough", () => {
    expect(clampAvailability("short")).toBe("short");
    expect(isWellFormed(clampAvailability("short"))).toBe(true);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `err ${String.fromCharCode(0xd800)} ${"x".repeat(600)}`;
    const out = clampAvailability(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes(String.fromCharCode(0xd800))).toBe(false);
  });

  it("sanitizes lone low surrogate", () => {
    const lone = `err ${String.fromCharCode(0xdc00)} ${"x".repeat(600)}`;
    const out = clampAvailability(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes(String.fromCharCode(0xdc00))).toBe(false);
  });

  it("sweep 0..30 offsets at 500 all well-formed", () => {
    const fox = "🦊";
    for (let n = 0; n <= 30; n++) {
      const input = `${"a".repeat(n)}${fox}${"b".repeat(600)}`;
      const out = clampAvailability(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(500);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });

  it("JSON stringify never throws on truncated payload", () => {
    const fox = "🦊";
    const payload = `${"x".repeat(499)}${fox}${"y".repeat(100)}`;
    const out = clampAvailability(payload);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify({ err: out })).not.toThrow();
  });
});
