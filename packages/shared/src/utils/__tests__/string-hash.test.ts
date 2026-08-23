import { describe, expect, it } from "vitest";
import { hashString } from "./string-hash.ts";

describe("hashString", () => {
  it("is deterministic for the same input", () => {
    expect(hashString("palette")).toBe(hashString("palette"));
    expect(hashString("")).toBe(hashString(""));
  });

  it("matches the classic JVM hashCode for a known string", () => {
    // "abc" → 96354 in JVM String.hashCode
    expect(hashString("abc")).toBe(96354);
  });

  it("returns a non-negative number", () => {
    for (const input of ["", "a", "hello world", "日本語", "🎨"]) {
      expect(hashString(input)).toBeGreaterThanOrEqual(0);
    }
  });

  it("distinguishes common inputs", () => {
    const a = hashString("red");
    const b = hashString("blue");
    const c = hashString("green");
    expect(new Set([a, b, c]).size).toBe(3);
  });
});
