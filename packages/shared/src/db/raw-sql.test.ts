/**
 * Unit coverage for shared raw-SQL execution, row validation, and encoders.
 */
import { describe, expect, it } from "vitest";
import {
  asObject,
  executeSql,
  extractRows,
  OptimisticLockError,
  parseJsonArray,
  parseJsonRecord,
  parseJsonValue,
  RawSqlError,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
  withOptimisticRetry,
} from "./raw-sql.ts";

describe("RawSqlError", () => {
  it("sets code, message, and optional rowIndex context", () => {
    const errWithoutIndex = new RawSqlError("SQL_RESULT_INVALID", "bad result");
    expect(errWithoutIndex.code).toBe("SQL_RESULT_INVALID");
    expect(errWithoutIndex.message).toBe("bad result");
    expect(errWithoutIndex.name).toBe("RawSqlError");
    expect(errWithoutIndex.context).toBeUndefined();

    const errWithIndex = new RawSqlError("SQL_RESULT_INVALID", "bad row", {
      rowIndex: 3,
    });
    expect(errWithIndex.context).toEqual({ rowIndex: 3 });
  });
});

describe("asObject", () => {
  it("returns plain objects and filters non-objects/arrays", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject(null)).toBeNull();
    expect(asObject(undefined)).toBeNull();
    expect(asObject([1, 2])).toBeNull();
    expect(asObject("string")).toBeNull();
    expect(asObject(42)).toBeNull();
    expect(asObject(true)).toBeNull();
  });
});

describe("toText", () => {
  it("converts primitives to text with fallback", () => {
    expect(toText("hello")).toBe("hello");
    expect(toText(null)).toBe("");
    expect(toText(undefined, "default")).toBe("default");
    expect(toText(123)).toBe("123");
    expect(toText(true)).toBe("true");
  });
});

describe("toNumber", () => {
  it("converts numbers and strings to number with fallback", () => {
    expect(toNumber(42)).toBe(42);
    expect(toNumber("42.5")).toBe(42.5);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined, 99)).toBe(99);
    expect(toNumber("invalid", 10)).toBe(10);
    expect(toNumber(Number.NaN, 5)).toBe(5);
    expect(toNumber(Number.POSITIVE_INFINITY, 5)).toBe(5);
  });
});

describe("toBoolean", () => {
  it("converts values to boolean with fallback", () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(false)).toBe(false);
    expect(toBoolean(1)).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean("true")).toBe(true);
    expect(toBoolean("1")).toBe(true);
    expect(toBoolean("yes")).toBe(true);
    expect(toBoolean("on")).toBe(true);
    expect(toBoolean("false")).toBe(false);
    expect(toBoolean("0")).toBe(false);
    expect(toBoolean("no")).toBe(false);
    expect(toBoolean("off")).toBe(false);
    expect(toBoolean("other", true)).toBe(true);
    expect(toBoolean(null, false)).toBe(false);
  });
});

describe("parseJsonValue / parseJsonRecord / parseJsonArray", () => {
  it("handles parseJsonValue with valid and invalid values", () => {
    expect(parseJsonValue(null, "fb")).toBe("fb");
    expect(parseJsonValue(undefined, "fb")).toBe("fb");
    expect(parseJsonValue("", "fb")).toBe("fb");
    expect(parseJsonValue({ a: 1 }, null)).toEqual({ a: 1 });
    expect(parseJsonValue('{"a":1}', null)).toEqual({ a: 1 });
    expect(() => parseJsonValue(123, null)).toThrowError(RawSqlError);
    expect(() => parseJsonValue("invalid json", null)).toThrowError(
      RawSqlError,
    );
  });

  it("handles parseJsonRecord", () => {
    expect(parseJsonRecord(null)).toEqual({});
    expect(parseJsonRecord('{"x":1}')).toEqual({ x: 1 });
    expect(parseJsonRecord({ x: 1 })).toEqual({ x: 1 });
    expect(() => parseJsonRecord("[1,2]")).toThrowError(RawSqlError);
    expect(() => parseJsonRecord(123)).toThrowError(RawSqlError);
  });

  it("handles parseJsonArray", () => {
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray("[1,2,3]")).toEqual([1, 2, 3]);
    expect(parseJsonArray([1, 2, 3])).toEqual([1, 2, 3]);
    expect(() => parseJsonArray('{"x":1}')).toThrowError(RawSqlError);
  });
});

describe("extractRows", () => {
  it("extracts from arrays and result envelopes", () => {
    expect(extractRows([{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }]);
    expect(extractRows({ rows: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(() => extractRows(null)).toThrowError(RawSqlError);
    expect(() => extractRows({})).toThrowError(RawSqlError);
    expect(() => extractRows({ rows: "not-an-array" })).toThrowError(
      RawSqlError,
    );
    expect(() => extractRows([{ id: 1 }, null])).toThrowError(RawSqlError);
  });
});

describe("executeSql", () => {
  it("delegates query to db.execute and extracts rows", async () => {
    const mockDb = {
      execute: async () => [{ id: "row1" }],
    };
    const rows = await executeSql(mockDb, "SELECT 1");
    expect(rows).toEqual([{ id: "row1" }]);
  });
});

describe("OptimisticLockError and withOptimisticRetry", () => {
  it("creates OptimisticLockError with attributes", () => {
    const err = new OptimisticLockError({
      table: "users",
      id: "u1",
      expectedVersion: 2,
    });
    expect(err.code).toBe("OPTIMISTIC_LOCK_ERROR");
    expect(err.table).toBe("users");
    expect(err.id).toBe("u1");
    expect(err.expectedVersion).toBe(2);
    expect(err.message).toContain("Optimistic lock conflict");
  });

  it("retries on OptimisticLockError and resolves on eventual success", async () => {
    let attempts = 0;
    const result = await withOptimisticRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new OptimisticLockError({
            table: "items",
            id: "1",
            expectedVersion: 1,
          });
        }
        return "success";
      },
      { maxAttempts: 3, baseDelayMs: 1 },
    );
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  it("propagates non-optimistic errors immediately without retry", async () => {
    let attempts = 0;
    await expect(
      withOptimisticRetry(
        async () => {
          attempts += 1;
          throw new Error("non-retryable");
        },
        { maxAttempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("non-retryable");
    expect(attempts).toBe(1);
  });

  it("throws when maxAttempts are exhausted", async () => {
    let attempts = 0;
    await expect(
      withOptimisticRetry(
        async () => {
          attempts += 1;
          throw new OptimisticLockError({
            table: "items",
            id: "1",
            expectedVersion: 1,
          });
        },
        { maxAttempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrowError(OptimisticLockError);
    expect(attempts).toBe(2);
  });
});

describe("SQL encoders", () => {
  it("encodes literals safely", () => {
    expect(sqlQuote("test's string")).toBe("'test''s string'");
    expect(sqlText("hello")).toBe("'hello'");
    expect(sqlText(null)).toBe("NULL");
    expect(sqlText(undefined)).toBe("NULL");

    expect(sqlInteger(42)).toBe("42");
    expect(sqlInteger(42.9)).toBe("42");
    expect(sqlInteger(null)).toBe("NULL");
    expect(() => sqlInteger(Number.NaN)).toThrowError(RawSqlError);

    expect(sqlNumber(42.5)).toBe("42.5");
    expect(sqlNumber(null)).toBe("NULL");
    expect(() => sqlNumber(Number.POSITIVE_INFINITY)).toThrowError(RawSqlError);

    expect(sqlBoolean(true)).toBe("TRUE");
    expect(sqlBoolean(false)).toBe("FALSE");

    expect(sqlJson({ key: "val" })).toBe('\'{"key":"val"}\'');
    expect(sqlJson(null)).toBe("'null'");
  });
});
