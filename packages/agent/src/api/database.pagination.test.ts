import { describe, expect, it } from "vitest";
import { parseRowsPagination } from "./database.ts";

/**
 * GET /api/database/tables/:table/rows interpolates `offset`/`limit` straight
 * into the SQL `LIMIT ... OFFSET ...` clause, so the parser must only ever
 * return safe non-negative integers. The old inline parse used
 * `Math.max(0, Number(raw))`, which propagates NaN (`?offset=abc` →
 * `OFFSET NaN` → SQL error → 500) and passes through floats and Infinity.
 */
describe("parseRowsPagination", () => {
  it("defaults when params are absent", () => {
    expect(parseRowsPagination(null, null)).toEqual({ offset: 0, limit: 50 });
  });

  it("parses valid integers", () => {
    expect(parseRowsPagination("120", "25")).toEqual({
      offset: 120,
      limit: 25,
    });
  });

  it("falls back to defaults on non-numeric input instead of producing NaN", () => {
    const { offset, limit } = parseRowsPagination("abc", "abc");
    expect(offset).toBe(0);
    expect(limit).toBe(50);
    expect(Number.isSafeInteger(offset)).toBe(true);
    expect(Number.isSafeInteger(limit)).toBe(true);
  });

  it("rejects floats and exponent notation (never interpolated raw)", () => {
    expect(parseRowsPagination("1.5", "2.9")).toEqual({
      offset: 0,
      limit: 50,
    });
    expect(parseRowsPagination("1e999", "1e999")).toEqual({
      offset: 0,
      limit: 50,
    });
    expect(parseRowsPagination("Infinity", "Infinity")).toEqual({
      offset: 0,
      limit: 50,
    });
  });

  it("clamps negatives and the limit ceiling", () => {
    expect(parseRowsPagination("-10", "-10")).toEqual({ offset: 0, limit: 1 });
    expect(parseRowsPagination("0", "0")).toEqual({ offset: 0, limit: 1 });
    expect(parseRowsPagination("3", "9999")).toEqual({ offset: 3, limit: 500 });
  });

  it("always yields SQL-safe integers for adversarial input", () => {
    for (const raw of ["NaN", " 7 ", "0x10", "12abc", "", "null", "-0"]) {
      const { offset, limit } = parseRowsPagination(raw, raw);
      expect(Number.isSafeInteger(offset)).toBe(true);
      expect(Number.isSafeInteger(limit)).toBe(true);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(limit).toBeGreaterThanOrEqual(1);
      expect(limit).toBeLessThanOrEqual(500);
    }
  });
});
