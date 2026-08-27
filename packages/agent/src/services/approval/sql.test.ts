/**
 * Unit coverage for approval-queue raw-SQL encoders, parsers, and runners.
 *
 * Drives `./sql.ts` directly. Literal encoding and JSON parsing are pure; row
 * extraction is asserted through `executeRawSql` / `executeRawSqlTx` against a
 * fake `adapter.db.execute` while `drizzle-orm`'s real `sql.raw` builds the
 * query object. No production helper is replaced with a mock.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  executeRawSql,
  executeRawSqlTx,
  parseJsonRecord,
  sqlInteger,
  sqlJson,
  sqlQuote,
  sqlText,
  type TransactionalDb,
  toText,
} from "./sql.ts";

function runtimeWithExecute(
  execute: (query: unknown) => Promise<unknown>,
): IAgentRuntime {
  return {
    adapter: { db: { execute } },
  } as IAgentRuntime;
}

function txWithExecute(
  execute: (query: unknown) => Promise<unknown>,
): TransactionalDb {
  return { execute };
}

describe("toText", () => {
  it("returns strings unchanged", () => {
    expect(toText("x")).toBe("x");
    expect(toText("")).toBe("");
  });

  it("uses the default empty fallback for nullish values", () => {
    expect(toText(null)).toBe("");
    expect(toText(undefined)).toBe("");
  });

  it("uses a caller-supplied fallback for nullish values", () => {
    expect(toText(null, "fb")).toBe("fb");
    expect(toText(undefined, "fb")).toBe("fb");
  });

  it("stringifies non-string values instead of falling back", () => {
    expect(toText(42)).toBe("42");
    expect(toText(false, "fb")).toBe("false");
    expect(toText({ a: 1 })).toBe("[object Object]");
  });
});

describe("parseJsonRecord", () => {
  it("parses a JSON object string", () => {
    expect(parseJsonRecord('{"k":"v","n":1}')).toEqual({ k: "v", n: 1 });
  });

  it("passes an already-parsed object through", () => {
    const value = { k: "v" };
    expect(parseJsonRecord(value)).toBe(value);
  });

  it("returns an empty object for missing JSON values", () => {
    expect(parseJsonRecord(null)).toEqual({});
    expect(parseJsonRecord(undefined)).toEqual({});
    expect(parseJsonRecord("")).toEqual({});
  });

  it("throws when the parsed value is not an object", () => {
    expect(() => parseJsonRecord("[1]")).toThrow("Expected JSON object");
    expect(() => parseJsonRecord([])).toThrow("Expected JSON object");
    expect(() => parseJsonRecord("null")).toThrow("Expected JSON object");
    expect(() => parseJsonRecord('"x"')).toThrow("Expected JSON object");
  });

  it("throws on invalid JSON strings and non-object primitives", () => {
    expect(() => parseJsonRecord("not json")).toThrow("Invalid JSON value");
    expect(() => parseJsonRecord(42)).toThrow(
      "Expected JSON string or object, received number",
    );
    expect(() => parseJsonRecord(true)).toThrow(
      "Expected JSON string or object, received boolean",
    );
  });
});

describe("sql literals", () => {
  it("quotes strings and doubles embedded single quotes", () => {
    expect(sqlQuote("plain")).toBe("'plain'");
    expect(sqlQuote("it's")).toBe("'it''s'");
    expect(sqlQuote("")).toBe("''");
    expect(sqlQuote("''")).toBe("''''''");
  });

  it("encodes nullable text as SQL NULL or a quoted literal", () => {
    expect(sqlText("plain")).toBe("'plain'");
    expect(sqlText("it's")).toBe("'it''s'");
    expect(sqlText("")).toBe("''");
    expect(sqlText(null)).toBe("NULL");
    expect(sqlText(undefined)).toBe("NULL");
  });

  it("truncates finite numbers and rejects non-finite values", () => {
    expect(sqlInteger(5.7)).toBe("5");
    expect(sqlInteger(-3.9)).toBe("-3");
    expect(sqlInteger(0)).toBe("0");
    expect(sqlInteger(null)).toBe("NULL");
    expect(sqlInteger(undefined)).toBe("NULL");
    expect(() => sqlInteger(Number.NaN)).toThrow("invalid numeric SQL literal");
    expect(() => sqlInteger(Number.POSITIVE_INFINITY)).toThrow(
      "invalid numeric SQL literal",
    );
    expect(() => sqlInteger(Number.NEGATIVE_INFINITY)).toThrow(
      "invalid numeric SQL literal",
    );
  });

  it("serializes JSON then quotes it as a SQL string", () => {
    expect(sqlJson({ a: 1 })).toBe("'{\"a\":1}'");
    expect(sqlJson(null)).toBe("'null'");
    expect(sqlJson(undefined)).toBe("'null'");
    expect(sqlJson([1, 2])).toBe("'[1,2]'");
    expect(sqlJson({ a: "it's" })).toBe("'{\"a\":\"it''s\"}'");
  });
});

describe("executeRawSql", () => {
  it("forwards the SQL text through drizzle sql.raw and extracts object rows from an array result", async () => {
    const seen: unknown[] = [];
    const runtime = runtimeWithExecute(async (query) => {
      seen.push(query);
      return [{ id: "a" }, { id: "b" }];
    });

    const rows = await executeRawSql(runtime, "SELECT 1");
    expect(rows).toEqual([{ id: "a" }, { id: "b" }]);
    expect(seen).toHaveLength(1);
    const query = seen[0] as { queryChunks: Array<{ value?: unknown }> };
    expect(query.queryChunks[0]?.value).toEqual(["SELECT 1"]);
  });

  it("returns an empty list for an empty array result", async () => {
    const runtime = runtimeWithExecute(async () => []);
    await expect(executeRawSql(runtime, "SELECT 1")).resolves.toEqual([]);
  });

  it("returns a single-element list for a single object row", async () => {
    const runtime = runtimeWithExecute(async () => [{ id: "only" }]);
    await expect(executeRawSql(runtime, "SELECT 1")).resolves.toEqual([
      { id: "only" },
    ]);
  });

  it("rejects non-object entries from an array result", async () => {
    const runtime = runtimeWithExecute(async () => [
      { id: "keep" },
      null,
      ["skip"],
      "nope",
      1,
    ]);
    await expect(executeRawSql(runtime, "SELECT 1")).rejects.toMatchObject({
      code: "RAW_SQL_ROW_SHAPE_INVALID",
    });
  });

  it("extracts object rows from a { rows } envelope", async () => {
    const runtime = runtimeWithExecute(async () => ({
      rows: [{ id: "a" }, { id: "b" }],
    }));
    await expect(executeRawSql(runtime, "SELECT 1")).resolves.toEqual([
      { id: "a" },
      { id: "b" },
    ]);
  });

  it("rejects when { rows } is missing or not an array", async () => {
    const missing = runtimeWithExecute(async () => ({ count: 0 }));
    const notArray = runtimeWithExecute(async () => ({ rows: "nope" }));
    await expect(executeRawSql(missing, "SELECT 1")).rejects.toMatchObject({
      code: "RAW_SQL_RESULT_SHAPE_INVALID",
    });
    await expect(executeRawSql(notArray, "SELECT 1")).rejects.toMatchObject({
      code: "RAW_SQL_RESULT_SHAPE_INVALID",
    });
  });

  it("rejects a non-object, non-array execute result", async () => {
    const none = runtimeWithExecute(async () => null);
    const scalar = runtimeWithExecute(async () => 42);
    await expect(executeRawSql(none, "SELECT 1")).rejects.toMatchObject({
      code: "RAW_SQL_RESULT_SHAPE_INVALID",
    });
    await expect(executeRawSql(scalar, "SELECT 1")).rejects.toMatchObject({
      code: "RAW_SQL_RESULT_SHAPE_INVALID",
    });
  });

  it("throws when the runtime database adapter is unavailable", async () => {
    const missingDb = { adapter: {} } as IAgentRuntime;
    const withoutExecute = {
      adapter: { db: {} },
    } as IAgentRuntime;
    await expect(executeRawSql(missingDb, "SELECT 1")).rejects.toThrow(
      "runtime database adapter unavailable",
    );
    await expect(executeRawSql(withoutExecute, "SELECT 1")).rejects.toThrow(
      "runtime database adapter unavailable",
    );
  });

  it("reuses the cached drizzle sql.raw on a subsequent call", async () => {
    const seen: unknown[] = [];
    const runtime = runtimeWithExecute(async (query) => {
      seen.push(query);
      return [];
    });
    await executeRawSql(runtime, "SELECT 2");
    await executeRawSql(runtime, "SELECT 3");
    expect(seen).toHaveLength(2);
    const first = seen[0] as { queryChunks: Array<{ value?: unknown }> };
    const second = seen[1] as { queryChunks: Array<{ value?: unknown }> };
    expect(first.queryChunks[0]?.value).toEqual(["SELECT 2"]);
    expect(second.queryChunks[0]?.value).toEqual(["SELECT 3"]);
  });
});

describe("executeRawSqlTx", () => {
  it("runs against the caller-owned handle and extracts rows", async () => {
    const seen: unknown[] = [];
    const tx = txWithExecute(async (query) => {
      seen.push(query);
      return { rows: [{ ok: true }] };
    });
    await expect(executeRawSqlTx(tx, "UPDATE t SET x = 1")).resolves.toEqual([
      { ok: true },
    ]);
    const query = seen[0] as { queryChunks: Array<{ value?: unknown }> };
    expect(query.queryChunks[0]?.value).toEqual(["UPDATE t SET x = 1"]);
  });

  it("returns an empty list for an empty transactional result", async () => {
    const tx = txWithExecute(async () => ({ rows: [] }));
    await expect(executeRawSqlTx(tx, "SELECT 1")).resolves.toEqual([]);
  });
});
