/** Surrogate safety for health-routes runtime debug serialization. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function previewString(value: string, maxLen: number): string {
  if (value.length <= maxLen) return toWellFormedUnicode(value);
  return `${truncateWellFormed(toWellFormedUnicode(value), maxLen - 3)}...`;
}

function serializeStack(stack: string, maxLen: number): string {
  if (stack.length <= maxLen) return toWellFormedUnicode(stack);
  return `${truncateWellFormed(toWellFormedUnicode(stack), maxLen - 3)}...`;
}

describe("health-routes surrogate safety", () => {
  test("string preview 200 backs off at surrogate without lone", () => {
    const fox = "🦊";
    const value = `${"a".repeat(197)}${fox}${"b".repeat(50)}`;
    const out = previewString(value, 200);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test("short string well-formed passthrough", () => {
    const value = "short value 🦊";
    const out = previewString(value, 200);
    expect(out).toBe(toWellFormedUnicode(value));
    expect(isWellFormed(out)).toBe(true);
  });

  test("stack 500 backs off at surrogate", () => {
    const fox = "🦊";
    const stack = `${"x".repeat(497)}${fox}${"y".repeat(100)}`;
    const out = serializeStack(stack, 500);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test("stack short well-formed", () => {
    const stack = "Error: short stack";
    const out = serializeStack(stack, 500);
    expect(out).toBe(toWellFormedUnicode(stack));
    expect(isWellFormed(out)).toBe(true);
  });

  test("lone surrogate sanitized in preview", () => {
    const lone = `val ${String.fromCharCode(0xd800)} ${"x".repeat(300)}`;
    const out = previewString(lone, 200);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  test("sweep offsets all well-formed", () => {
    const fox = "🦊";
    for (let n = 195; n <= 205; n++) {
      const val = `${"a".repeat(n)}${fox}${"b".repeat(20)}`;
      const out = previewString(val, 200);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});
