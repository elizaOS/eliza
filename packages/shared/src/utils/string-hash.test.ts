/**
 * Unit tests for deterministic string hashing in packages/shared/src/utils/string-hash.ts.
 * Exercises JVM-style polynomial hash computation, empty string handling, non-negative return guarantees,
 * and hash separation across varying string inputs.
 */
import { describe, expect, it } from "vitest";
import { hashString } from "./string-hash.js";

describe("string-hash utilities", () => {
  describe("hashString", () => {
    it("computes deterministic hash values for strings", () => {
      const input = "test-character-seed";
      const hash1 = hashString(input);
      const hash2 = hashString(input);
      expect(hash1).toBe(hash2);
      expect(typeof hash1).toBe("number");
    });

    it("returns 0 for empty string input", () => {
      expect(hashString("")).toBe(0);
    });

    it("matches expected polynomial hash calculations", () => {
      // "a" -> 97
      expect(hashString("a")).toBe(97);
      // "ab" -> (97 * 31 + 98) = 3105
      expect(hashString("ab")).toBe(3105);
    });

    it("produces distinct hashes for different string inputs", () => {
      const inputs = [
        "agent-1",
        "agent-2",
        "eliza-core",
        "eliza-shared",
        "theme-dark",
        "theme-light",
      ];
      const hashes = new Set(inputs.map((s) => hashString(s)));
      expect(hashes.size).toBe(inputs.length);
    });

    it("always returns non-negative integers across long strings with potential overflow", () => {
      const longInput = "a".repeat(1000);
      const hash = hashString(longInput);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(hash)).toBe(true);

      const mixedInput = "special_!@#$%^&*()_+=~`{}[]:;\"'<>,.?/".repeat(50);
      const mixedHash = hashString(mixedInput);
      expect(mixedHash).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(mixedHash)).toBe(true);
    });
  });
});
