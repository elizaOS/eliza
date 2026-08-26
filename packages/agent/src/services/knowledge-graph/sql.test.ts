/**
 * Unit coverage for knowledge-graph raw-SQL encoders, parsers, and runners.
 *
 * Drives `./sql.ts` directly. Literal encoding and JSON parsing are pure; row
 * extraction is asserted through `executeRawSql` against a fake
 * `adapter.db.execute` while `drizzle-orm`'s real `sql.raw` builds the query
 * object. No production helper is replaced with a mock.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  executeRawSql,
  parseJsonArray,
  parseJsonRecord,
  parseJsonValue,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  toBoolean,
  toNumber,
  toText,
} from "./sql.ts";

function runtimeWithExecute(
  execute: (query: unknown) => Promise<unknown>,
): IAgentRuntime {
  return {
    adapter: { db: { execute } },
  } as IAgentRuntime;
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

describe("toNumber", () => {
  it("returns finite numbers unchanged", () => {
    expect(toNumber(5)).toBe(5);
    expect(toNumber(0)).toBe(0);
    expect(toNumber(-3.25)).toBe(-3.25);
  });

  it("parses finite numeric strings", () => {
    expect(toNumber("7.5")).toBe(7.5);
    expect(toNumber("0")).toBe(0);
    expect(toNumber("  3  ")).toBe(3);
    expect(toNumber("")).toBe(0);
  });

  it("uses the default zero fallback for non-numeric values", () => {
    expect(toNumber("abc")).toBe(0);
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
    expect(toNumber(true)).toBe(0);
    expect(toNumber({ n: 1 })).toBe(0);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
  });

  it("uses a caller-supplied fallback for non-numeric values", () => {
    expect(toNumber(undefined, 9)).toBe(9);
    expect(toNumber("abc", 9)).toBe(9);
    expect(toNumber(Number.NaN, 9)).toBe(9);
  });
});

describe("toBoolean", () => {
  it("returns booleans unchanged", () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(false)).toBe(false);
  });

  it("treats any non-zero number as true, including NaN", () => {
    expect(toBoolean(1)).toBe(true);
    expect(toBoolean(-1)).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean(Number.NaN)).toBe(true);
  });

  it("parses trimmed case-insensitive truthy and falsy strings", () => {
    expect(toBoolean("1")).toBe(true);
    expect(toBoolean("TRUE")).toBe(true);
    expect(toBoolean(" yes ")).toBe(true);
    expect(toBoolean("On")).toBe(true);
    expect(toBoolean("0")).toBe(false);
    expect(toBoolean("false")).toBe(false);
    expect(toBoolean("NO")).toBe(false);
    expect(toBoolean(" off ")).toBe(false);
  });

  it("uses the fallback for unrecognized strings and other types", () => {
    expect(toBoolean("maybe")).toBe(false);
    expect(toBoolean("", true)).toBe(true);
    expect(toBoolean(null, true)).toBe(true);
    expect(toBoolean(undefined)).toBe(false);
    expect(toBoolean({ ok: 1 })).toBe(false);
  });
});

describe("parseJsonValue", () => {
  it("returns the fallback for missing JSON values", () => {
    expect(parseJsonValue(null, { fallback: true })).toEqual({
      fallback: true,
    });
    expect(parseJsonValue(undefined, 7)).toBe(7);
    expect(parseJsonValue("", "fb")).toBe("fb");
  });

  it("passes objects and arrays through without re-parsing", () => {
    const object = { a: 1 };
    const array = [1, 2];
    expect(parseJsonValue(object, null)).toBe(object);
    expect(parseJsonValue(array, null)).toBe(array);
  });

  it("parses a JSON string", () => {
    expect(parseJsonValue('{"a":1}', null)).toEqual({ a: 1 });
    expect(parseJsonValue("null", { fallback: true })).toBeNull();
  });

  it("throws on invalid JSON strings and non-object primitives", () => {
    expect(() => parseJsonValue("not json", null)).toThrow(
      "Invalid JSON value",
    );
    expect(() => parseJsonValue(42, null)).toThrow(
      "Expected JSON string or object, received number",
    );
    expect(() => parseJsonValue(true, null)).toThrow(
      "Expected JSON string or object, received boolean",
    );
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

describe("parseJsonArray", () => {
  it("parses a JSON array string", () => {
    expect(parseJsonArray("[1,2]")).toEqual([1, 2]);
  });

  it("passes an already-parsed array through", () => {
    const value = [{ id: "a" }];
    expect(parseJsonArray(value)).toBe(value);
  });

  it("returns an empty array for missing JSON values", () => {
    expect(parseJsonArray(null)).toEqual([]);
    expect(parseJsonArray(undefined)).toEqual([]);
    expect(parseJsonArray("")).toEqual([]);
  });

  it("throws when the parsed value is not an array", () => {
    expect(() => parseJsonArray('{"a":1}')).toThrow("Expected JSON array");
    expect(() => parseJsonArray({ a: 1 })).toThrow("Expected JSON array");
    expect(() => parseJsonArray("null")).toThrow("Expected JSON array");
    expect(() => parseJsonArray('"x"')).toThrow("Expected JSON array");
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

  it("truncates finite integers and rejects non-finite values", () => {
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

  it("encodes finite numbers without truncation and rejects non-finite values", () => {
    expect(sqlNumber(3.14)).toBe("3.14");
    expect(sqlNumber(-2.5)).toBe("-2.5");
    expect(sqlNumber(0)).toBe("0");
    expect(sqlNumber(null)).toBe("NULL");
    expect(sqlNumber(undefined)).toBe("NULL");
    expect(() => sqlNumber(Number.NaN)).toThrow("invalid numeric SQL literal");
    expect(() => sqlNumber(Number.POSITIVE_INFINITY)).toThrow(
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
