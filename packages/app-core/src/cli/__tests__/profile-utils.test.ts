import { describe, expect, it } from "vitest";
import {
  isValidProfileName,
  normalizeProfileName,
} from "./profile-utils.ts";

describe("isValidProfileName", () => {
  it("accepts path-safe names", () => {
    expect(isValidProfileName("alice")).toBe(true);
    expect(isValidProfileName("my-profile_2")).toBe(true);
    expect(isValidProfileName("A1-b")).toBe(true);
  });

  it("rejects empty, spaces, and shell metacharacters", () => {
    expect(isValidProfileName("")).toBe(false);
    expect(isValidProfileName("has space")).toBe(false);
    expect(isValidProfileName("a;rm")).toBe(false);
    expect(isValidProfileName("a/b")).toBe(false);
    expect(isValidProfileName("-leading")).toBe(false);
  });

  it("enforces the 64-char cap", () => {
    expect(isValidProfileName("a".repeat(64))).toBe(true);
    expect(isValidProfileName("a".repeat(65))).toBe(false);
  });
});

describe("normalizeProfileName", () => {
  it("trims and passes through valid names", () => {
    expect(normalizeProfileName("  alice  ")).toBe("alice");
  });

  it("returns null for empty, default, and invalid", () => {
    expect(normalizeProfileName("")).toBeNull();
    expect(normalizeProfileName("  ")).toBeNull();
    expect(normalizeProfileName("Default")).toBeNull();
    expect(normalizeProfileName("bad name")).toBeNull();
    expect(normalizeProfileName(undefined)).toBeNull();
    expect(normalizeProfileName(null)).toBeNull();
  });
});
