/**
 * Surrogate-safe truncation for custom-actions output (4000 + maxChars caps).
 * Verifies caps never split an astral surrogate pair and lone surrogates are sanitized.
 */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, it } from "vitest";

function clampOutput(text: string): string {
  return truncateWellFormed(toWellFormedUnicode(text), 4000);
}

function clampBody(text: string, maxChars = 4000): string {
  return truncateWellFormed(toWellFormedUnicode(text), maxChars);
}

function isWellFormed(value: string): boolean {
  const w = value as unknown as { isWellFormed?: () => boolean };
  if (typeof w.isWellFormed === "function") return w.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

describe("custom-actions surrogate handling", () => {
  it("backs off astral at 4000: 3999+fox tail → 3999 well-formed", () => {
    const input = `${"a".repeat(3999)}🦊${"b".repeat(20)}`;
    const out = clampOutput(input);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify({ output: out })).not.toThrow();
    expect(out.length).toBe(3999);
    expect(out.endsWith("🦊")).toBe(false);
  });

  it("keeps fitting emoji exactly at 4000: 3998+fox → 4000 well-formed", () => {
    const input = `${"a".repeat(3998)}🦊`;
    const out = clampOutput(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(4000);
    expect(out.endsWith("🦊")).toBe(true);
  });

  it("short output passthrough remains well-formed", () => {
    const text = "Done";
    expect(clampOutput(text)).toBe(text);
    expect(isWellFormed(clampOutput(text))).toBe(true);
    expect(isWellFormed(clampBody(text))).toBe(true);
  });

  it("sanitizes lone high surrogate", () => {
    const lone = `ok ${String.fromCharCode(0xd800)} text ${"a".repeat(4000)}`;
    const out = clampOutput(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes(String.fromCharCode(0xd800))).toBe(false);
  });

  it("sanitizes lone low surrogate", () => {
    const lone = `ok ${String.fromCharCode(0xdc00)} text ${"a".repeat(4000)}`;
    const out = clampBody(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("sweep 0..30 offsets at 4000 output cap all well-formed", () => {
    const fox = "🦊";
    for (let n = 0; n <= 30; n++) {
      const input = `${"a".repeat(3970 + n)}${fox}${"b".repeat(100)}`;
      const out = clampOutput(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(4000);
      expect(() => JSON.stringify({ output: out })).not.toThrow();
    }
  });

  it("sweep 0..30 offsets at 4000 body cap all well-formed", () => {
    const fox = "🦊";
    for (let n = 0; n <= 30; n++) {
      const input = `${"a".repeat(3970 + n)}${fox}${"b".repeat(100)}`;
      const out = clampBody(input, 4000);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(4000);
      expect(() => JSON.stringify({ text: out })).not.toThrow();
    }
  });

  it("JSON.stringify never throws for truncated output with astral", () => {
    const input = `${"a".repeat(3999)}🦊${"b".repeat(50)}`;
    const out = clampOutput(input);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(isWellFormed(out)).toBe(true);
    expect(JSON.stringify(out).includes("\\ud83e")).toBe(false);
  });
});
