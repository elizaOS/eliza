/**
 * Coverage for validation helpers.
 */
import { describe, expect, it } from "vitest";

import { isValidUUID, sanitizeUUID } from "./validation.js";

describe("isValidUUID", () => {
  it("accepts valid v4 uuid", () => {
    expect(isValidUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("accepts uppercase", () => {
    expect(isValidUUID("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("rejects invalid", () => {
    expect(isValidUUID("not-a-uuid")).toBe(false);
    expect(isValidUUID("")).toBe(false);
    expect(isValidUUID("550e8400-e29b-41d4-a716-44665544000")).toBe(false);
  });

  it("rejects non-string", () => {
    expect(isValidUUID(null as unknown as string)).toBe(false);
    expect(isValidUUID(undefined as unknown as string)).toBe(false);
  });
});

describe("sanitizeUUID", () => {
  it("returns trimmed uuid preserving case", () => {
    expect(sanitizeUUID("  550e8400-e29b-41d4-a716-446655440000  ")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(sanitizeUUID("  550E8400-E29B-41D4-A716-446655440000  ")).toBe(
      "550E8400-E29B-41D4-A716-446655440000",
    );
  });

  it("strips trailing slash and backslash", () => {
    expect(sanitizeUUID("550e8400-e29b-41d4-a716-446655440000/")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(sanitizeUUID("550e8400-e29b-41d4-a716-446655440000\\")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("returns undefined for invalid", () => {
    expect(sanitizeUUID("not-a-uuid")).toBeUndefined();
    expect(sanitizeUUID("")).toBeUndefined();
  });

  it("returns undefined for missing", () => {
    expect(sanitizeUUID(null)).toBeUndefined();
    expect(sanitizeUUID(undefined)).toBeUndefined();
  });
});
