/**
 * Unit tests for hashString in packages/shared/src/utils/string-hash.ts.
 * Exercises deterministic hashing across runs, distinct output distributions,
 * non-negative return values, and non-string/empty input handling.
 */
import { describe, expect, it } from "vitest";
import { hashString } from "./string-hash.js";

describe("hashString", () => {
  it("computes deterministic hash values for strings", () => {
    const h1 = hashString("eliza");
    const h2 = hashString("eliza");
    expect(h1).toBe(h2);
    expect(typeof h1).toBe("number");
    expect(h1).toBeGreaterThan(0);
  });

  it("produces different hashes for different string inputs", () => {
    const h1 = hashString("agent-alpha");
    const h2 = hashString("agent-beta");
    expect(h1).not.toBe(h2);
  });

  it("always returns non-negative numbers", () => {
    const samples = [
      "",
      "a",
      "hello world",
      "test-12345",
      "long string ".repeat(50),
    ];
    for (const sample of samples) {
      const hash = hashString(sample);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(hash)).toBe(true);
    }
  });

  it("returns 0 for empty, null, or undefined inputs", () => {
    expect(hashString("")).toBe(0);
    expect(hashString(null)).toBe(0);
    expect(hashString(undefined)).toBe(0);
  });

  it("returns 0 safely for non-string inputs without throwing", () => {
    expect(hashString(123 as unknown as string)).toBe(0);
    expect(hashString({} as unknown as string)).toBe(0);
    expect(hashString([] as unknown as string)).toBe(0);
    expect(hashString(true as unknown as string)).toBe(0);
  });
});
