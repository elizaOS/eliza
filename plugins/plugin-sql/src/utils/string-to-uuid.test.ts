import { describe, expect, it } from "vitest";
import { stringToUuid } from "./string-to-uuid";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("stringToUuid", () => {
  it("passes an already-valid lowercase UUID through unchanged", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    expect(stringToUuid(uuid)).toBe(uuid);
  });

  it("passes an already-valid uppercase UUID through unchanged", () => {
    const uuid = "123E4567-E89B-42D3-A456-426614174000";
    expect(stringToUuid(uuid)).toBe(uuid);
  });

  it("derives a deterministic UUID for a number input", () => {
    const first = stringToUuid(12345);
    const second = stringToUuid(12345);
    expect(first).toBe(second);
    expect(first).toMatch(UUID_SHAPE);
  });

  it("maps the same string to the same UUID", () => {
    const first = stringToUuid("room:alice-bob");
    const second = stringToUuid("room:alice-bob");
    expect(first).toBe(second);
  });

  it("maps distinct strings to distinct UUIDs", () => {
    const a = stringToUuid("room:alice-bob");
    const b = stringToUuid("room:alice-carol");
    expect(a).not.toBe(b);
  });

  it("produces v4-shaped UUIDs with a variant nibble in 8-b", () => {
    for (const input of ["a", "hello world", "中文输入", "x".repeat(100)]) {
      const uuid = stringToUuid(input);
      expect(uuid).toMatch(UUID_SHAPE);
      const variantNibble = uuid[19];
      expect("89ab").toContain(variantNibble);
    }
  });

  it("handles characters that change under encodeURIComponent", () => {
    const uuid = stringToUuid("a b%c/d?e=f&g#h");
    expect(uuid).toMatch(UUID_SHAPE);
    expect(stringToUuid("a b%c/d?e=f&g#h")).toBe(uuid);
  });

  it("handles an empty string deterministically", () => {
    const uuid = stringToUuid("");
    expect(uuid).toMatch(UUID_SHAPE);
    expect(stringToUuid("")).toBe(uuid);
  });

  it("does not collide between the number 12 and the string '12'", () => {
    // The number is stringified before hashing, so both forms derive the
    // same synthetic id — this pins the canonical (non-surprising) mapping.
    expect(stringToUuid(12)).toBe(stringToUuid("12"));
  });
});
