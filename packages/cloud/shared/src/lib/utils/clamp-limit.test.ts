/**
 * Regression for #20450 — clamp-limit helper.
 * Three list endpoints (user redemptions fallback 20, admin 50, charges 50)
 * must clamp to 1..100. Old: Math.min(parseInt(...),100) leaked NaN/-5.
 */

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

  test.each([
    ["abc", "abc"],
    ["-5", "-5"],
    ["0", "0"],
    ["-1", "-1"],
  ])("malformed %s → fallback", (_name, limit) => {
    expect(parseClampedLimit(limit, 20)).toBe(20);
    expect(parseClampedLimit(limit, 50)).toBe(50);
  });

  test("5junk → 5 (parseInt behavior preserved)", () => {
    expect(parseClampedLimit("5junk", 20)).toBe(5);
    expect(parseClampedLimit("5junk", 50)).toBe(5);
  });

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

  describe("sabotage — old Math.min(parseInt,100) leaks", () => {
    test("old admin leaks NaN for abc", () => {
      const old = (param: string | null) => (param ? Math.min(parseInt(param, 10), 100) : 50);
      expect(old("abc")).toBeNaN();
      expect(parseClampedLimit("abc", 50)).toBe(50);
      expect(Number.isNaN(parseClampedLimit("abc", 50))).toBe(false);
    });

    test("old admin leaks -5", () => {
      const old = (param: string | null) => (param ? Math.min(parseInt(param, 10), 100) : 50);
      expect(old("-5")).toBe(-5);
      expect(parseClampedLimit("-5", 50)).toBe(50);
    });

    test("old charges leaks -5 via Number.isFinite", () => {
      const old = (param: string | null) => {
        const limit = param ? Number.parseInt(param, 10) : 50;
        return Number.isFinite(limit) ? limit : 50;
      };
      expect(old("-5")).toBe(-5);
      expect(parseClampedLimit("-5", 50)).toBe(50);
    });

    test("old leaks 0", () => {
      const old = (param: string | null) => (param ? Math.min(parseInt(param, 10), 100) : 20);
      expect(old("0")).toBe(0);
      expect(parseClampedLimit("0", 20)).toBe(20);
    });
  });
});
