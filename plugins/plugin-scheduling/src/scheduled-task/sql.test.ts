import { describe, expect, it } from "vitest";
import {
  asObject,
  createRuntimeSchedulingSqlExecutor,
  executeRawSql,
  extractRows,
  getRuntimeDb,
  parseJsonRecord,
  parseJsonValue,
  sqlBoolean,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  toBoolean,
  toText,
} from "./sql";

describe("scheduled-task/sql value coercion", () => {
  it("sqlQuote doubles embedded single quotes to prevent SQL string break-out", () => {
    expect(sqlQuote("O'Brien")).toBe("'O''Brien'");
    expect(sqlQuote("plain")).toBe("'plain'");
    expect(sqlQuote("")).toBe("''");
    expect(sqlQuote("it's a 'quote'")).toBe("'it''s a ''quote'''");
  });

  it("sqlText encodes null/undefined as NULL and strings via sqlQuote", () => {
    expect(sqlText(null)).toBe("NULL");
    expect(sqlText(undefined)).toBe("NULL");
    expect(sqlText("a'b")).toBe("'a''b'");
    expect(sqlText("x")).toBe("'x'");
  });

  it("sqlInteger rejects non-finite numbers and truncates fractional values", () => {
    expect(sqlInteger(42)).toBe("42");
    expect(sqlInteger(1.5)).toBe("1");
    expect(sqlInteger(-3.9)).toBe("-3");
    expect(() => sqlInteger(Number.NaN)).toThrow("invalid numeric SQL literal");
    expect(() => sqlInteger(Number.POSITIVE_INFINITY)).toThrow(
      "invalid numeric SQL literal",
    );
  });

  it("sqlBoolean emits SQL boolean literals", () => {
    expect(sqlBoolean(true)).toBe("TRUE");
    expect(sqlBoolean(false)).toBe("FALSE");
  });

  it("sqlJson stringifies values through the quote seam, null-safe", () => {
    expect(sqlJson({ a: 1 })).toBe("'{\"a\":1}'");
    expect(sqlJson(null)).toBe("'null'");
    expect(sqlJson(undefined)).toBe("'null'");
    expect(sqlJson("O'Brien")).toBe("'\"O''Brien\"'");
  });
});

describe("scheduled-task/sql row coercion", () => {
  it("asObject returns records only, rejecting arrays and primitives", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject(null)).toBeNull();
    expect(asObject(undefined)).toBeNull();
    expect(asObject([1, 2])).toBeNull();
    expect(asObject("x")).toBeNull();
    expect(asObject(3)).toBeNull();
  });

  it("toText falls back for nullish and stringifies primitives", () => {
    expect(toText("keep")).toBe("keep");
    expect(toText(null)).toBe("");
    expect(toText(undefined, "fb")).toBe("fb");
    expect(toText(123)).toBe("123");
    expect(toText(true)).toBe("true");
  });

  it("toBoolean normalizes string truthiness and rejects unknown values", () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean(2)).toBe(true);
    expect(toBoolean(" TRUE ")).toBe(true);
    expect(toBoolean("yes")).toBe(true);
    expect(toBoolean("on")).toBe(true);
    expect(toBoolean("1")).toBe(true);
    expect(toBoolean("false")).toBe(false);
    expect(toBoolean("no")).toBe(false);
    expect(toBoolean("off")).toBe(false);
    expect(toBoolean("banana")).toBe(false);
    expect(toBoolean("2")).toBe(false);
    expect(toBoolean(null)).toBe(false);
    expect(toBoolean(undefined, true)).toBe(true);
  });

  it("extractRows flattens array results and {rows} results, dropping non-records", () => {
    expect(extractRows([{ a: 1 }, null, "x", { b: 2 }])).toEqual([
      { a: 1 },
      { b: 2 },
    ]);
    expect(extractRows({ rows: [{ a: 1 }, 7] })).toEqual([{ a: 1 }]);
    expect(extractRows({ rows: "nope" })).toEqual([]);
    expect(extractRows({})).toEqual([]);
    expect(extractRows(null)).toEqual([]);
    expect(extractRows("not an object")).toEqual([]);
  });
});

describe("scheduled-task/sql JSON parsing boundaries", () => {
  it("parseJsonValue treats missing values as fallback", () => {
    expect(parseJsonValue(null, 5)).toBe(5);
    expect(parseJsonValue(undefined, 5)).toBe(5);
    expect(parseJsonValue("", 5)).toBe(5);
  });

  it("parseJsonValue passes objects through and parses JSON strings", () => {
    expect(parseJsonValue({ a: 1 }, null)).toEqual({ a: 1 });
    expect(parseJsonValue('{"a":1}', null)).toEqual({ a: 1 });
    expect(parseJsonValue("[1,2]", null)).toEqual([1, 2]);
  });

  it("parseJsonValue throws on primitive non-string values", () => {
    expect(() => parseJsonValue(42, null)).toThrow(
      "[SchedulingSql] Expected JSON string or object, received number",
    );
    expect(() => parseJsonValue(true, null)).toThrow(
      "[SchedulingSql] Expected JSON string or object, received boolean",
    );
  });

  it("parseJsonValue wraps malformed JSON parse failures", () => {
    expect(() => parseJsonValue("{nope", null)).toThrow(
      "[SchedulingSql] Invalid JSON value:",
    );
  });

  it("parseJsonRecord requires an object, rejecting arrays", () => {
    expect(parseJsonRecord(null)).toEqual({});
    expect(parseJsonRecord('{"a":1}')).toEqual({ a: 1 });
    expect(() => parseJsonRecord("[]")).toThrow(
      "[SchedulingSql] Expected JSON object",
    );
    expect(() => parseJsonRecord("[1]")).toThrow(
      "[SchedulingSql] Expected JSON object",
    );
  });
});

describe("scheduled-task/sql runtime DB access", () => {
  const adapterDb = { execute: async () => [{ ok: 1 }] };
  const runtimeDb = { execute: async () => [{ ok: 2 }] };

  it("getRuntimeDb prefers the adapter db and falls back to runtime.db", () => {
    expect(getRuntimeDb({ adapter: { db: adapterDb } })).toBe(adapterDb);
    expect(getRuntimeDb({ db: runtimeDb })).toBe(runtimeDb);
    expect(getRuntimeDb({ adapter: { db: adapterDb }, db: runtimeDb })).toBe(
      adapterDb,
    );
  });

  it("getRuntimeDb returns null when neither execute-capable db exists", () => {
    expect(getRuntimeDb({})).toBeNull();
    expect(getRuntimeDb({ adapter: {} })).toBeNull();
    expect(getRuntimeDb({ adapter: { db: {} } })).toBeNull();
  });

  it("executeRawSql runs raw SQL through the runtime db and extracts rows", async () => {
    const db = { execute: async () => ({ rows: [{ id: 1 }] }) };
    const rows = await executeRawSql({ adapter: { db } }, "SELECT 1");
    expect(rows).toEqual([{ id: 1 }]);
  });

  it("executeRawSql fails loud when no runtime db is available", async () => {
    await expect(executeRawSql({}, "SELECT 1")).rejects.toThrow(
      "runtime database adapter unavailable",
    );
  });

  it("createRuntimeSchedulingSqlExecutor delegates to executeRawSql", async () => {
    const db = { execute: async () => [{ n: 7 }] };
    const exec = createRuntimeSchedulingSqlExecutor({ adapter: { db } });
    await expect(exec("SELECT n")).resolves.toEqual([{ n: 7 }]);
  });
});

describe("scheduled-task/sql cache seam", () => {
  it("sql.raw returns the query-chunks shape the db adapter executes", async () => {
    const { sql } = await import("drizzle-orm");
    const raw = sql.raw("DELETE FROM t WHERE id = 'O''Brien'");
    expect(raw.queryChunks).toHaveLength(1);
    expect(raw.queryChunks[0].value).toBe(
      "DELETE FROM t WHERE id = 'O''Brien'",
    );
  });
});
