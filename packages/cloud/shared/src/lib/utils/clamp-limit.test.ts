/** Deterministic tests for the shared bounded list-limit query contract. */

import { describe, expect, test } from "bun:test";
import { parseClampedLimit } from "./clamp-limit";

describe("parseClampedLimit", () => {
  test("absent → fallback", () => {
    expect(parseClampedLimit(null, 20)).toBe(20);
    expect(parseClampedLimit(undefined, 50)).toBe(50);
    expect(parseClampedLimit("", 20)).toBe(20);
  });

  test.each([5, 20, 50, 100])("valid %i unchanged", (limit) => {
    expect(parseClampedLimit(String(limit), 20)).toBe(limit);
    expect(parseClampedLimit(String(limit), 50)).toBe(limit);
  });

  test.each(["abc", "-5", "0", "-1", "+5", "5.5", "5junk", " 5"])(
    "malformed %s → fallback",
    (limit) => {
      expect(parseClampedLimit(limit, 20)).toBe(20);
      expect(parseClampedLimit(limit, 50)).toBe(50);
    },
  );

  test.each([
    ["101", 100],
    ["999999", 100],
    ["200", 100],
  ])("above max %s → 100", (limit, expected) => {
    expect(parseClampedLimit(limit, 20)).toBe(expected);
    expect(parseClampedLimit(limit, 50)).toBe(expected);
  });

  test("custom max respected", () => {
    expect(parseClampedLimit("600", 20, 500)).toBe(500);
    expect(parseClampedLimit("400", 20, 500)).toBe(400);
  });
});
