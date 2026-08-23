import { describe, expect, it } from "vitest";
import { hashString } from "./string-hash.ts";

describe("hashString", () => {
  it("is deterministic", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
  });

  it("matches JVM String.hashCode for known values", () => {
    expect(hashString("")).toBe(0);
    expect(hashString("a")).toBe(97);
    // "abc" → 97*31² + 98*31 + 99 = 96354
    expect(hashString("abc")).toBe(96354);
  });

  it("returns non-negative values", () => {
    expect(hashString("~".repeat(50))).toBeGreaterThanOrEqual(0);
  });

  it("distinguishes different inputs", () => {
    expect(hashString("cat")).not.toBe(hashString("dog"));
  });
});
