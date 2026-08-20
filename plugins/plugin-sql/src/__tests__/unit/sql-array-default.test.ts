/**
 * Unit tests for Postgres array-literal rendering of Drizzle column defaults.
 * Covers honest scalars/nests plus fail-closed depth on hostile plugin schemas.
 */
import { ElizaError } from "@elizaos/core";
import { integer, pgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { generateSnapshot } from "../../runtime-migrator/drizzle-adapters/snapshot-generator";
import {
  buildArrayString,
  MAX_SQL_ARRAY_DEFAULT_CHARS,
  MAX_SQL_ARRAY_DEFAULT_DEPTH,
  MAX_SQL_ARRAY_DEFAULT_ELEMENTS,
  SQL_ARRAY_DEFAULT_UNBOUNDED,
} from "../../runtime-migrator/drizzle-adapters/sql-array-default";

function nestArray(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) {
    value = [value];
  }
  return value;
}

describe("buildArrayString", () => {
  it("renders honest scalars, dates, and one nested array", () => {
    expect(buildArrayString([1, 2, 3], "integer[]")).toBe("{1,2,3}");
    expect(buildArrayString([true, false], "boolean[]")).toBe("{true,false}");
    expect(buildArrayString(["a", "b"], "text[]")).toBe('{"a","b"}');
    expect(buildArrayString([[1, 2], [3]], "integer[]")).toBe("{{1,2},{3}}");
    expect(buildArrayString([new Date("2026-08-20T00:00:00.000Z")], "date[]")).toBe(
      '{"2026-08-20"}'
    );
  });

  it(`accepts a ${MAX_SQL_ARRAY_DEFAULT_DEPTH}-deep array nest`, () => {
    const rendered = buildArrayString(
      nestArray(MAX_SQL_ARRAY_DEFAULT_DEPTH) as number[],
      "integer[]"
    );
    expect(rendered.startsWith("{")).toBe(true);
    expect(rendered.includes("1")).toBe(true);
  });

  it(`throws ${SQL_ARRAY_DEFAULT_UNBOUNDED} one past depth ${MAX_SQL_ARRAY_DEFAULT_DEPTH}`, () => {
    expect(() =>
      buildArrayString(nestArray(MAX_SQL_ARRAY_DEFAULT_DEPTH + 1) as number[], "integer[]")
    ).toThrowError(ElizaError);
    try {
      buildArrayString(nestArray(MAX_SQL_ARRAY_DEFAULT_DEPTH + 1) as number[], "integer[]");
    } catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      expect((error as ElizaError).code).toBe(SQL_ARRAY_DEFAULT_UNBOUNDED);
      expect(error).not.toBeInstanceOf(RangeError);
    }
  });

  it("does not RangeError a 4k array nest", () => {
    const t0 = performance.now();
    expect(() => buildArrayString(nestArray(4000) as number[], "integer[]")).toThrowError(
      ElizaError
    );
    expect(performance.now() - t0).toBeLessThan(50);
  });

  it("fails before traversing an oversized sparse array", () => {
    expect(() =>
      buildArrayString(new Array(MAX_SQL_ARRAY_DEFAULT_ELEMENTS + 1), "integer[]")
    ).toThrowError(ElizaError);
  });

  it("fails before wrapping an oversized string element", () => {
    expect(() =>
      buildArrayString(["x".repeat(MAX_SQL_ARRAY_DEFAULT_CHARS)], "text[]")
    ).toThrowError(ElizaError);
  });

  it("fails closed through the production snapshot boundary", async () => {
    const hostileDefault = nestArray(4000) as number[];
    const table = pgTable("hostile_array_default", {
      values: integer("values").array().default(hostileDefault),
    });

    await expect(generateSnapshot({ table })).rejects.toMatchObject({
      code: SQL_ARRAY_DEFAULT_UNBOUNDED,
    });
  });
});
