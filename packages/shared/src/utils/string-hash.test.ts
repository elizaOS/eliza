/**
 * Unit tests for hashString in packages/shared/src/utils/string-hash.ts.
 * Exercises deterministic hashing, non-negativity, character sensitivity,
 * empty string handling, and nullish/non-string input guards.
 */
import { describe, expect, it } from "vitest";
import { hashString } from "./string-hash.js";

describe("hashString", () => {
  it("produces deterministic non-negative integer hashes", () => {
    const hash1 = hashString("eliza-app");
    const hash2 = hashString("eliza-app");
    expect(hash1).toBe(hash2);
    expect(Number.isInteger(hash1)).toBe(true);
    expect(hash1).toBeGreaterThanOrEqual(0);
  });

  it("calculates expected hashCode algorithm values", () => {
    // "hello" -> 99162322
    expect(hashString("hello")).toBe(99162322);
    // "a" -> 97
    expect(hashString("a")).toBe(97);
  });

  it("differentiates between distinct string inputs", () => {
    const hashA = hashString("assistant");
    const hashB = hashString("agent");
    const hashC = hashString("system");
    expect(hashA).not.toBe(hashB);
    expect(hashB).not.toBe(hashC);
  });

  it("returns 0 for empty, null, undefined, or non-string inputs", () => {
    expect(hashString("")).toBe(0);
    expect(hashString(null)).toBe(0);
    expect(hashString(undefined)).toBe(0);
    expect(hashString(12345 as unknown as string)).toBe(0);
    expect(hashString({} as unknown as string)).toBe(0);
  });
});
