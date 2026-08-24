/**
 * Unit tests for cloud DB execute helper utilities.
 * Validates driver rows extraction and row count normalization.
 */

import type { SQLWrapper } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { mutateRowCount, type SqlExecutor, sqlRows } from "../execute-helpers.ts";

describe("execute-helpers", () => {
  describe("sqlRows", () => {
    it("extracts rows array from valid database execution result", async () => {
      const fakeDb: SqlExecutor = {
        execute: async () => ({
          rows: [
            { id: 1, name: "Alice" },
            { id: 2, name: "Bob" },
          ],
        }),
      };
      const dummyQuery = {} as SQLWrapper;
      const rows = await sqlRows<{ id: number; name: string }>(fakeDb, dummyQuery);
      expect(rows).toEqual([
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ]);
    });

    it("throws error if execute result is not an object with rows", async () => {
      const fakeDb: SqlExecutor = {
        execute: async () => null,
      };
      const dummyQuery = {} as SQLWrapper;
      await expect(sqlRows(fakeDb, dummyQuery)).rejects.toThrow(
        "[sqlRows] execute() did not return an object with rows",
      );
    });

    it("throws error if rows property is not an array", async () => {
      const fakeDb: SqlExecutor = {
        execute: async () => ({ rows: "not-an-array" }),
      };
      const dummyQuery = {} as SQLWrapper;
      await expect(sqlRows(fakeDb, dummyQuery)).rejects.toThrow(
        "[sqlRows] execute().rows is not an array",
      );
    });
  });

  describe("mutateRowCount", () => {
    it("extracts valid numeric rowCount", () => {
      expect(mutateRowCount({ rowCount: 5 })).toBe(5);
      expect(mutateRowCount({ rowCount: 0 })).toBe(0);
    });

    it("returns 0 for missing or non-numeric rowCount", () => {
      expect(mutateRowCount({})).toBe(0);
      expect(mutateRowCount({ rowCount: "5" })).toBe(0);
      expect(mutateRowCount(null)).toBe(0);
      expect(mutateRowCount(undefined)).toBe(0);
      expect(mutateRowCount("string-result")).toBe(0);
    });
  });
});
