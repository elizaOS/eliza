/**
 * Validation Utilities Unit Tests
 *
 * Tests for lib/utils/validation.ts
 * Covers UUID validation and sanitization functions.
 */

import { describe, expect, test } from "bun:test";
import { isValidUUID, sanitizeUUID } from "@/lib/utils/validation";

describe("isValidUUID", () => {
  test("returns true for valid UUID v4", () => {
    expect(isValidUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidUUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
    expect(isValidUUID("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(true);
  });

  test("returns true for UUIDs with different versions (1-5)", () => {
    // UUID v1
    expect(isValidUUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
    // UUID v4
    expect(isValidUUID("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(true);
    // UUID v5
    expect(isValidUUID("886313e1-3b8a-5372-9b90-0c9aee199e5d")).toBe(true);
  });

  test("returns true for uppercase UUIDs", () => {
    expect(isValidUUID("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
    expect(isValidUUID("F47AC10B-58CC-4372-A567-0E02B2C3D479")).toBe(true);
  });

  test("returns false for UUID with trailing backslash (common URL encoding issue)", () => {
    expect(isValidUUID("17c8b876-86a0-465d-9794-2aea244f4239\\")).toBe(false);
    expect(isValidUUID("f47ac10b-58cc-4372-a567-0e02b2c3d479\\")).toBe(false);
  });

  test("returns false for UUID with trailing forward slash", () => {
    expect(isValidUUID("17c8b876-86a0-465d-9794-2aea244f4239/")).toBe(false);
  });

  test("returns false for UUID with whitespace", () => {
    expect(isValidUUID("17c8b876-86a0-465d-9794-2aea244f4239 ")).toBe(false);
    expect(isValidUUID(" 17c8b876-86a0-465d-9794-2aea244f4239")).toBe(false);
    expect(isValidUUID("17c8b876-86a0-465d-9794-2aea244f4239\n")).toBe(false);
  });

  test("returns false for malformed UUIDs", () => {
    expect(isValidUUID("not-a-uuid")).toBe(false);
    expect(isValidUUID("12345678")).toBe(false);
    expect(isValidUUID("")).toBe(false);
    expect(isValidUUID("550e8400-e29b-41d4-a716")).toBe(false); // Too short
    expect(isValidUUID("550e8400-e29b-41d4-a716-446655440000-extra")).toBe(false); // Too long
  });

  test("returns false for UUIDs with invalid characters", () => {
    expect(isValidUUID("550e8400-e29b-41d4-a716-44665544000g")).toBe(false); // 'g' is invalid
    expect(isValidUUID("550e8400-e29b-41d4-a716-44665544000!")).toBe(false);
  });

  test("returns false for UUID without hyphens", () => {
    expect(isValidUUID("550e8400e29b41d4a716446655440000")).toBe(false);
  });
});

describe("sanitizeUUID", () => {
  test("returns valid UUID unchanged", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(sanitizeUUID(uuid)).toBe(uuid);
  });

  test("removes trailing backslash and returns valid UUID", () => {
    expect(sanitizeUUID("17c8b876-86a0-465d-9794-2aea244f4239\\")).toBe(
      "17c8b876-86a0-465d-9794-2aea244f4239",
    );
    // Multiple backslashes
    expect(sanitizeUUID("17c8b876-86a0-465d-9794-2aea244f4239\\\\")).toBe(
      "17c8b876-86a0-465d-9794-2aea244f4239",
    );
  });

  test("removes trailing forward slash and returns valid UUID", () => {
    expect(sanitizeUUID("17c8b876-86a0-465d-9794-2aea244f4239/")).toBe(
      "17c8b876-86a0-465d-9794-2aea244f4239",
    );
  });

  test("removes trailing whitespace and returns valid UUID", () => {
    expect(sanitizeUUID("17c8b876-86a0-465d-9794-2aea244f4239 ")).toBe(
      "17c8b876-86a0-465d-9794-2aea244f4239",
    );
    expect(sanitizeUUID("17c8b876-86a0-465d-9794-2aea244f4239\t")).toBe(
      "17c8b876-86a0-465d-9794-2aea244f4239",
    );
  });

  test("trims leading whitespace before validation", () => {
    expect(sanitizeUUID("  17c8b876-86a0-465d-9794-2aea244f4239")).toBe(
      "17c8b876-86a0-465d-9794-2aea244f4239",
    );
  });

  test("returns undefined for null/undefined input", () => {
    expect(sanitizeUUID(null)).toBeUndefined();
    expect(sanitizeUUID(undefined)).toBeUndefined();
  });

  test("returns undefined for empty string", () => {
    expect(sanitizeUUID("")).toBeUndefined();
    expect(sanitizeUUID("   ")).toBeUndefined();
  });

  test("returns undefined for completely invalid input", () => {
    expect(sanitizeUUID("not-a-uuid")).toBeUndefined();
    expect(sanitizeUUID("12345")).toBeUndefined();
    expect(sanitizeUUID("hello\\")).toBeUndefined();
  });

  test("handles real-world URL-decoded backslash case from error logs", () => {
    // This is the exact pattern from the production error logs
    // URL: ?characterId=17c8b876-86a0-465d-9794-2aea244f4239%5C
    // Decoded: 17c8b876-86a0-465d-9794-2aea244f4239\
    const malformedId = "17c8b876-86a0-465d-9794-2aea244f4239\\";
    const sanitized = sanitizeUUID(malformedId);

    expect(sanitized).toBe("17c8b876-86a0-465d-9794-2aea244f4239");
    expect(isValidUUID(sanitized!)).toBe(true);
  });

  test("handles multiple types of trailing garbage", () => {
    // Combination of backslash, slash, and whitespace
    expect(sanitizeUUID("17c8b876-86a0-465d-9794-2aea244f4239\\ /")).toBe(
      "17c8b876-86a0-465d-9794-2aea244f4239",
    );
    expect(sanitizeUUID("17c8b876-86a0-465d-9794-2aea244f4239/\\")).toBe(
      "17c8b876-86a0-465d-9794-2aea244f4239",
    );
    expect(sanitizeUUID("17c8b876-86a0-465d-9794-2aea244f4239 \\")).toBe(
      "17c8b876-86a0-465d-9794-2aea244f4239",
    );
  });

  test("handles multiple whitespace types", () => {
    // Tab, newline, space combinations
    expect(sanitizeUUID("17c8b876-86a0-465d-9794-2aea244f4239\t\n ")).toBe(
      "17c8b876-86a0-465d-9794-2aea244f4239",
    );
    expect(sanitizeUUID("17c8b876-86a0-465d-9794-2aea244f4239  \t")).toBe(
      "17c8b876-86a0-465d-9794-2aea244f4239",
    );
  });

  test("rejects UUIDs with embedded invalid characters (fail-fast)", () => {
    // Embedded invalid chars should cause rejection, not sanitization
    expect(sanitizeUUID("550e8400-e29b-INVALID-446655440000")).toBeUndefined();
    expect(sanitizeUUID("550e8400\\e29b-41d4-a716-446655440000")).toBeUndefined();
    expect(sanitizeUUID("550e8400-e29b-41d4-a716-446655440000\x00")).toBeUndefined();
  });
});
