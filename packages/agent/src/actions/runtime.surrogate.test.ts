/** Surrogate safety for runtime self-status and restart reason truncation. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function truncateSelfStatus(rawText: string, maxChars: number): string {
  const suffix = "\n…[self-status truncated]";
  const wellFormedSuffix = toWellFormedUnicode(suffix);
  const wellFormedRaw = toWellFormedUnicode(rawText);
  if (wellFormedRaw.length <= maxChars) return wellFormedRaw;
  if (maxChars <= wellFormedSuffix.length)
    return truncateWellFormed(wellFormedSuffix, maxChars);
  return `${truncateWellFormed(wellFormedRaw, maxChars - wellFormedSuffix.length)}${wellFormedSuffix}`;
}

function truncateRestartReason(reason: string): string {
  return truncateWellFormed(toWellFormedUnicode(reason), 240);
}

describe("runtime surrogate safety", () => {
  test("self-status 100 truncation backs off at surrogate without lone", () => {
    const fox = "🦊";
    const raw = `${"a".repeat(96)}${fox}${"b".repeat(50)}`;
    const out = truncateSelfStatus(raw, 100);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out.endsWith("…[self-status truncated]")).toBe(true);
  });

  test("self-status 10 keeps suffix well-formed when maxChars <= suffix", () => {
    const out = truncateSelfStatus("x".repeat(100), 10);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(10);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test("self-status short text passes through well-formed", () => {
    const text = "short status";
    const out = truncateSelfStatus(text, 1000);
    expect(out).toBe(toWellFormedUnicode(text));
    expect(isWellFormed(out)).toBe(true);
  });

  test("restart reason 240 backs off at surrogate boundary", () => {
    const fox = "🦊";
    const reason = `${"a".repeat(239)}${fox}${"b".repeat(10)}`;
    const out = truncateRestartReason(reason);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(239);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test("restart reason sanitizes lone surrogate", () => {
    const lone = `reason ${String.fromCharCode(0xd800)} ${"x".repeat(300)}`;
    const out = truncateRestartReason(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes(String.fromCharCode(0xd800))).toBe(false);
  });

  test("sweep self-status offsets all stay well-formed", () => {
    const fox = "🦊";
    for (let n = 5; n <= 15; n++) {
      const raw = `${"a".repeat(80)}${fox}${"b".repeat(80)}`;
      const out = truncateSelfStatus(raw, 90 + n);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});
