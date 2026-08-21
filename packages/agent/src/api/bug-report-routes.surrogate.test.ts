/** Surrogate safety for bug-report sanitize. */

import { toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { describe, expect, test } from "vitest";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

function sanitize(input: string, maxLen = 10_000): string {
  const clipped =
    input.length > maxLen
      ? truncateWellFormed(toWellFormedUnicode(input), maxLen)
      : toWellFormedUnicode(input);
  let prev = clipped;
  let next = prev.replace(/<[^<>]{0,1024}>/g, "");
  while (next !== prev) {
    prev = next;
    next = prev.replace(/<[^<>]{0,1024}>/g, "");
  }
  return truncateWellFormed(
    toWellFormedUnicode(next.replace(/[<>]/g, "")),
    maxLen,
  );
}

describe("bug-report sanitize surrogate safety", () => {
  test("10k boundary backs off at surrogate without lone", () => {
    const fox = "🦊";
    const input = `${"a".repeat(9_999)}${fox}${"b".repeat(50)}`;
    const out = sanitize(input, 10_000);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(9_999);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test("short input well-formed passthrough", () => {
    const input = "short bug report 🦊";
    const out = sanitize(input);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test("html stripping preserves well-formed", () => {
    const input = `<b>${"a".repeat(9_990)}🦊</b>${"c".repeat(50)}`;
    const out = sanitize(input, 10_000);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("<")).toBe(false);
    expect(out.includes(">")).toBe(false);
  });

  test("lone surrogate sanitized to replacement", () => {
    const lone = `report ${String.fromCharCode(0xd800)} ${"x".repeat(15_000)}`;
    const out = sanitize(lone, 10_000);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes(String.fromCharCode(0xd800))).toBe(false);
  });

  test("second clamp also well-formed", () => {
    const fox = "🦊";
    const input = `${"<tag>"}${"a".repeat(9_998)}${fox}${"b".repeat(20)}`;
    const out = sanitize(input, 10_000);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(10_000);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  test("sweep offsets all well-formed", () => {
    const fox = "🦊";
    for (let n = 9_995; n <= 10_005; n++) {
      const input = `${"a".repeat(n)}${fox}${"b".repeat(20)}`;
      const out = sanitize(input, 10_000);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });
});
