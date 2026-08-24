import { describe, expect, it } from "vitest";
import { mutateRowCount, sqlRows } from "./execute-helpers.js";

describe("execute-helpers", () => {
  it("sqlRows returns rows on valid shape", async () => {
    const db = { execute: async () => ({ rows: [{ id: 1 }] }) } as never;
    const rows = await sqlRows(db, {} as never);
    expect(rows).toEqual([{ id: 1 }]);
  });

  it("sqlRows throws on invalid shape", async () => {
    const db = { execute: async () => ({}) } as never;
    await expect(sqlRows(db, {} as never)).rejects.toThrow(/rows/);
    const db2 = { execute: async () => ({ rows: "bad" }) } as never;
    await expect(sqlRows(db2, {} as never)).rejects.toThrow(/rows/);
    const db3 = { execute: async () => null } as never;
    await expect(sqlRows(db3, {} as never)).rejects.toThrow(/rows/);
  });

  it("mutateRowCount extracts number", () => {
    expect(mutateRowCount({ rowCount: 5 })).toBe(5);
    expect(mutateRowCount({ rowCount: "5" })).toBe(0);
    expect(mutateRowCount({})).toBe(0);
    expect(mutateRowCount(null)).toBe(0);
  });
});
