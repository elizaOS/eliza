import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  executeRawSql,
  executeRawSqlTx,
  extractRows,
  getRuntimeDb,
  parseJsonArray,
  parseJsonRecord,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
  withCalendarTransaction,
} from "./sql";

describe("calendar/internal/sql value coercion", () => {
  it("toText falls back for nullish and stringifies primitives", () => {
    expect(toText("keep")).toBe("keep");
    expect(toText(null)).toBe("");
    expect(toText(undefined, "fb")).toBe("fb");
    expect(toText(123)).toBe("123");
    expect(toText(false)).toBe("false");
  });

  it("toNumber rejects non-finite numbers and unparsable strings", () => {
    expect(toNumber(7)).toBe(7);
    expect(toNumber("42")).toBe(42);
    expect(toNumber(" 3.5 ")).toBe(3.5);
    expect(toNumber("abc", -1)).toBe(-1);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(Number.NaN, 9)).toBe(9);
    expect(toNumber(Number.POSITIVE_INFINITY, 9)).toBe(9);
  });

  it("toBoolean normalizes string truthiness and rejects unknown values", () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean(3)).toBe(true);
    expect(toBoolean(" TRUE ")).toBe(true);
    expect(toBoolean("yes")).toBe(true);
    expect(toBoolean("on")).toBe(true);
    expect(toBoolean("1")).toBe(true);
    expect(toBoolean("off")).toBe(false);
    expect(toBoolean("no")).toBe(false);
    expect(toBoolean("0")).toBe(false);
    expect(toBoolean("banana", true)).toBe(true);
    expect(toBoolean(null)).toBe(false);
  });
});

describe("calendar/internal/sql JSON parsing boundaries", () => {
  it("parseJsonRecord requires an object and defaults missing values to {}", () => {
    expect(parseJsonRecord(null)).toEqual({});
    expect(parseJsonRecord("")).toEqual({});
    expect(parseJsonRecord('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJsonRecord("[]")).toThrow(
      "[CalendarSql] Expected JSON object",
    );
    expect(() => parseJsonRecord("[1,2]")).toThrow(
      "[CalendarSql] Expected JSON object",
    );
  });

  it("parseJsonArray requires an array and defaults missing values to []", () => {
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray(undefined)).toEqual([]);
    expect(parseJsonArray("")).toEqual([]);
    expect(parseJsonArray("[1,2]")).toEqual([1, 2]);
    expect(() => parseJsonArray("{}")).toThrow(
      "[CalendarSql] Expected JSON array",
    );
    expect(() => parseJsonArray('{"a":1}')).toThrow(
      "[CalendarSql] Expected JSON array",
    );
  });

  it("parseJsonArray wraps malformed JSON parse failures", () => {
    expect(() => parseJsonArray("{nope")).toThrow(
      "[CalendarSql] Invalid JSON value:",
    );
  });
});

describe("calendar/internal/sql row extraction", () => {
  it("extractRows flattens array results and {rows} results, dropping non-records", () => {
    expect(extractRows([{ a: 1 }, null, 5, { b: 2 }])).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
    expect(extractRows({ rows: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(extractRows({ rows: [] })).toEqual([]);
    expect(extractRows({ rows: "x" })).toEqual([]);
    expect(extractRows("junk")).toEqual([]);
    expect(extractRows(undefined)).toEqual([]);
  });
});

describe("calendar/internal/sql runtime DB access", () => {
  it("getRuntimeDb returns the adapter db and fails loud when absent", () => {
    const db = { execute: async () => [] };
    expect(getRuntimeDb({ adapter: { db } })).toBe(db);
    expect(() => getRuntimeDb({})).toThrow(
      "runtime database adapter unavailable",
    );
    expect(() => getRuntimeDb({ db: { execute: async () => [] } })).toThrow(
      "runtime database adapter unavailable",
    );
  });

  it("executeRawSql runs raw SQL through the adapter and extracts rows", async () => {
    const db = { execute: async () => [{ id: 1 }] };
    await expect(
      executeRawSql({ adapter: { db } }, "SELECT id FROM t"),
    ).resolves.toEqual([{ id: 1 }]);
  });

  it("executeRawSqlTx runs raw SQL through a transaction handle", async () => {
    const tx = { execute: async () => ({ rows: [{ n: 1 }] }) };
    await expect(executeRawSqlTx(tx, "UPDATE t SET n = 1")).resolves.toEqual([
      { n: 1 },
    ]);
  });

  it("withCalendarTransaction rejects non-transactional adapters with a typed error", async () => {
    const db = { execute: async () => [] };
    const err = await withCalendarTransaction(
      { agentId: "agent-1", adapter: { db } },
      async () => "never",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElizaError);
    const elizaErr = err as ElizaError;
    expect(elizaErr.code).toBe("CALENDAR_SOURCE_TRANSACTION_REQUIRED");
    expect(elizaErr.context).toEqual({ agentId: "agent-1" });
  });

  it("withCalendarTransaction commits through the adapter transaction", async () => {
    const tx = { execute: async () => [] };
    const db = {
      execute: async () => [],
      transaction: async (op: unknown) => op(tx),
    };
    const result = await withCalendarTransaction(
      { agentId: "agent-2", adapter: { db } },
      async (handle) => {
        expect(handle).toBe(tx);
        return "committed";
      },
    );
    expect(result).toBe("committed");
  });
});

describe("calendar/internal/sql SQL literal encoding", () => {
  it("sqlQuote doubles embedded single quotes to prevent SQL string break-out", () => {
    expect(sqlQuote("O'Brien")).toBe("'O''Brien'");
    expect(sqlQuote("plain")).toBe("'plain'");
    expect(sqlQuote("")).toBe("''");
  });

  it("sqlText encodes null/undefined as NULL", () => {
    expect(sqlText(null)).toBe("NULL");
    expect(sqlText(undefined)).toBe("NULL");
    expect(sqlText("a'b")).toBe("'a''b'");
  });

  it("sqlBoolean emits SQL boolean literals", () => {
    expect(sqlBoolean(true)).toBe("TRUE");
    expect(sqlBoolean(false)).toBe("FALSE");
  });

  it("sqlInteger rejects unsafe integers instead of emitting lossy literals", () => {
    expect(sqlInteger(42)).toBe("42");
    expect(sqlInteger(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(() => sqlInteger(1.5)).toThrow("invalid integer SQL literal");
    expect(() => sqlInteger(Number.NaN)).toThrow("invalid integer SQL literal");
    expect(() => sqlInteger(Number.POSITIVE_INFINITY)).toThrow(
      "invalid integer SQL literal",
    );
    expect(() => sqlInteger(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "invalid integer SQL literal",
    );
  });

  it("sqlJson stringifies values through the quote seam, null-safe", () => {
    expect(sqlJson({ a: 1 })).toBe("'{\"a\":1}'");
    expect(sqlJson(null)).toBe("'null'");
    expect(sqlJson(undefined)).toBe("'null'");
  });
});
