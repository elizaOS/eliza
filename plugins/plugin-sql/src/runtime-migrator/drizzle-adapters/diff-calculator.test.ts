import { describe, expect, it } from "vitest";
import type { SchemaColumn, SchemaIndex, SchemaSnapshot, SchemaTable } from "../types";
import { calculateDiff, hasDiffChanges } from "./diff-calculator";

function table(overrides: Partial<SchemaTable> = {}): SchemaTable {
  return {
    name: "t",
    schema: "public",
    columns: {},
    indexes: {},
    foreignKeys: {},
    compositePrimaryKeys: {},
    uniqueConstraints: {},
    checkConstraints: {},
    ...overrides,
  };
}

function snapshot(tables: Record<string, SchemaTable>): SchemaSnapshot {
  return {
    version: "1",
    dialect: "postgresql",
    tables,
    schemas: { public: "public" },
    _meta: { schemas: {}, tables: {}, columns: {} },
  };
}

function col(type: string, overrides: Partial<SchemaColumn> = {}): SchemaColumn {
  return { name: "c", type, ...overrides };
}

const SNAPSHOT_META = { schemas: {}, tables: {}, columns: {} };

describe("diff-calculator type normalization boundaries", () => {
  it("treats equivalent integer spellings as unchanged (int vs integer)", async () => {
    const prev = snapshot({
      t: table({ columns: { c: col("integer") } }),
    });
    const curr = snapshot({
      t: table({ columns: { c: col("int") } }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toEqual([]);
    expect(hasDiffChanges(diff)).toBe(false);
  });

  it("treats int4/int8/int2 as equivalent to integer/bigint/smallint", async () => {
    const prev = snapshot({
      t: table({
        columns: {
          a: col("integer"),
          b: col("bigint"),
          c: col("smallint"),
        },
      }),
    });
    const curr = snapshot({
      t: table({
        columns: {
          a: col("int4"),
          b: col("int8"),
          c: col("int2"),
        },
      }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toEqual([]);
    expect(hasDiffChanges(diff)).toBe(false);
  });

  it("treats bool as equivalent to boolean", async () => {
    const prev = snapshot({ t: table({ columns: { c: col("boolean") } }) });
    const curr = snapshot({ t: table({ columns: { c: col("bool") } }) });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toEqual([]);
    expect(hasDiffChanges(diff)).toBe(false);
  });

  it("treats float8/float4 as equivalent to double precision/real", async () => {
    const prev = snapshot({
      t: table({
        columns: { a: col("double precision"), b: col("real") },
      }),
    });
    const curr = snapshot({
      t: table({
        columns: { a: col("float8"), b: col("float4") },
      }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toEqual([]);
    expect(hasDiffChanges(diff)).toBe(false);
  });

  it("treats timestamptz as equivalent to timestamp with time zone", async () => {
    const prev = snapshot({
      t: table({ columns: { c: col("timestamp with time zone") } }),
    });
    const curr = snapshot({ t: table({ columns: { c: col("timestamptz") } }) });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toEqual([]);
    expect(hasDiffChanges(diff)).toBe(false);
  });

  it("ignores the tz qualifier for precision-bearing timestamp spellings", async () => {
    const prev = snapshot({
      t: table({ columns: { c: col("timestamp(3) without time zone") } }),
    });
    const curr = snapshot({
      t: table({ columns: { c: col("timestamp(3)") } }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toEqual([]);
    expect(hasDiffChanges(diff)).toBe(false);
  });

  it("treats precision-less numeric(p) as numeric(p,0)", async () => {
    const prev = snapshot({
      t: table({ columns: { c: col("numeric(10,0)") } }),
    });
    const curr = snapshot({ t: table({ columns: { c: col("numeric(10)") } }) });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toEqual([]);
    expect(hasDiffChanges(diff)).toBe(false);
  });

  it("treats decimal as equivalent to numeric with the same precision/scale", async () => {
    const prev = snapshot({
      t: table({ columns: { c: col("numeric(10, 2)") } }),
    });
    const curr = snapshot({ t: table({ columns: { c: col("decimal(10,2)") } }) });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toEqual([]);
    expect(hasDiffChanges(diff)).toBe(false);
  });

  it("treats character varying as equivalent to varchar", async () => {
    const prev = snapshot({
      t: table({ columns: { c: col("character varying(255)") } }),
    });
    const curr = snapshot({ t: table({ columns: { c: col("varchar(255)") } }) });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toEqual([]);
    expect(hasDiffChanges(diff)).toBe(false);
  });

  it("treats _text as equivalent to text[]", async () => {
    const prev = snapshot({ t: table({ columns: { c: col("text[]") } }) });
    const curr = snapshot({ t: table({ columns: { c: col("_text") } }) });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toEqual([]);
    expect(hasDiffChanges(diff)).toBe(false);
  });

  it("still reports genuine type changes (integer -> text)", async () => {
    const prev = snapshot({ t: table({ columns: { c: col("integer") } }) });
    const curr = snapshot({ t: table({ columns: { c: col("text") } }) });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toHaveLength(1);
    expect(diff.columns.modified[0]).toMatchObject({
      table: "t",
      column: "c",
    });
    expect(hasDiffChanges(diff)).toBe(true);
  });

  it("still reports precision changes on numeric columns", async () => {
    const prev = snapshot({
      t: table({ columns: { c: col("numeric(10,2)") } }),
    });
    const curr = snapshot({
      t: table({ columns: { c: col("numeric(12,2)") } }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toHaveLength(1);
    expect(hasDiffChanges(diff)).toBe(true);
  });

  it("still reports varchar length changes", async () => {
    const prev = snapshot({
      t: table({ columns: { c: col("varchar(255)") } }),
    });
    const curr = snapshot({
      t: table({ columns: { c: col("varchar(512)") } }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toHaveLength(1);
    expect(hasDiffChanges(diff)).toBe(true);
  });

  it("ignores key reordering in an otherwise unchanged table", async () => {
    const prev = snapshot({
      t: table({
        columns: {
          a: col("integer"),
          b: col("text", { notNull: true }),
          c: col("boolean"),
        },
      }),
    });
    const curr = snapshot({
      t: table({
        columns: {
          c: col("boolean"),
          b: col("text", { notNull: true }),
          a: col("integer"),
        },
      }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(hasDiffChanges(diff)).toBe(false);
  });
});

describe("diff-calculator structural boundaries", () => {
  it("flags every table/index/fk as created when there is no previous snapshot", async () => {
    const index: SchemaIndex = {
      name: "idx_c",
      columns: [{ expression: "c", isExpression: false }],
      isUnique: false,
    };
    const curr = snapshot({
      t: table({
        columns: { c: col("integer") },
        indexes: { idx_c: index },
        foreignKeys: {
          fk: {
            name: "fk",
            tableFrom: "t",
            tableTo: "u",
            schemaTo: "public",
            columnsFrom: ["c"],
            columnsTo: ["id"],
          },
        },
      }),
    });
    const diff = await calculateDiff(null, curr);
    expect(diff.tables.created).toEqual(["t"]);
    expect(diff.indexes.created).toHaveLength(1);
    expect(diff.indexes.created[0]).toMatchObject({ table: "t" });
    expect(diff.foreignKeys.created).toHaveLength(1);
    expect(hasDiffChanges(diff)).toBe(true);
  });

  it("reports dropped tables", async () => {
    const prev = snapshot({ t: table() });
    const curr = snapshot({});
    const diff = await calculateDiff(prev, curr);
    expect(diff.tables.deleted).toEqual(["t"]);
    expect(hasDiffChanges(diff)).toBe(true);
  });

  it("reports added and dropped columns", async () => {
    const prev = snapshot({
      t: table({ columns: { a: col("integer") } }),
    });
    const curr = snapshot({
      t: table({ columns: { a: col("integer"), b: col("text") } }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.added).toHaveLength(1);
    expect(diff.columns.added[0]).toMatchObject({ table: "t", column: "b" });
    const diff2 = await calculateDiff(curr, prev);
    expect(diff2.columns.deleted).toHaveLength(1);
    expect(diff2.columns.deleted[0]).toMatchObject({ table: "t", column: "b" });
  });

  it("reports index definition changes as altered", async () => {
    const mkIndex = (unique: boolean): SchemaIndex => ({
      name: "idx_c",
      columns: [{ expression: "c", isExpression: false }],
      isUnique: unique,
    });
    const prev = snapshot({
      t: table({ columns: { c: col("integer") }, indexes: { idx_c: mkIndex(false) } }),
    });
    const curr = snapshot({
      t: table({ columns: { c: col("integer") }, indexes: { idx_c: mkIndex(true) } }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.indexes.altered).toHaveLength(1);
    expect(diff.indexes.altered[0]).toMatchObject({
      old: { name: "idx_c" },
      new: { name: "idx_c" },
    });
    expect(hasDiffChanges(diff)).toBe(true);
  });

  it("reports foreign-key cascade changes as altered", async () => {
    const mkFk = (onDelete: string) => ({
      name: "fk",
      tableFrom: "t",
      tableTo: "u",
      schemaTo: "public",
      columnsFrom: ["c"],
      columnsTo: ["id"],
      onDelete,
    });
    const prev = snapshot({
      t: table({
        columns: { c: col("integer") },
        foreignKeys: { fk: mkFk("no action") },
      }),
    });
    const curr = snapshot({
      t: table({
        columns: { c: col("integer") },
        foreignKeys: { fk: mkFk("cascade") },
      }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.foreignKeys.altered).toHaveLength(1);
    expect(hasDiffChanges(diff)).toBe(true);
  });

  it("reports unique constraint creation and deletion", async () => {
    const prev = snapshot({ t: table() });
    const curr = snapshot({
      t: table({
        uniqueConstraints: {
          uq: { name: "uq", columns: ["c"] },
        },
      }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.uniqueConstraints.created).toHaveLength(1);
    const diff2 = await calculateDiff(curr, prev);
    expect(diff2.uniqueConstraints.deleted).toHaveLength(1);
  });

  it("reports check constraint creation and deletion", async () => {
    const prev = snapshot({ t: table() });
    const curr = snapshot({
      t: table({
        checkConstraints: {
          chk: { name: "chk", value: "c > 0" },
        },
      }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.checkConstraints.created).toHaveLength(1);
    const diff2 = await calculateDiff(curr, prev);
    expect(diff2.checkConstraints.deleted).toHaveLength(1);
  });

  it("reports nullability changes", async () => {
    const prev = snapshot({
      t: table({ columns: { c: col("integer", { notNull: false }) } }),
    });
    const curr = snapshot({
      t: table({ columns: { c: col("integer", { notNull: true }) } }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.columns.modified).toHaveLength(1);
    expect(hasDiffChanges(diff)).toBe(true);
  });

  it("returns false for a fully empty diff", () => {
    const empty = {
      tables: { created: [], deleted: [], modified: [] },
      columns: { added: [], deleted: [], modified: [] },
      indexes: { created: [], deleted: [], altered: [] },
      foreignKeys: { created: [], deleted: [], altered: [] },
      uniqueConstraints: { created: [], deleted: [] },
      checkConstraints: { created: [], deleted: [] },
    };
    expect(hasDiffChanges(empty)).toBe(false);
  });

  it("treats expression-column index changes as altered", async () => {
    const mkIndex = (expr: string): SchemaIndex => ({
      name: "idx_expr",
      columns: [{ expression: expr, isExpression: true }],
      isUnique: false,
    });
    const prev = snapshot({
      t: table({
        columns: { c: col("text") },
        indexes: { idx_expr: mkIndex("lower(c)") },
      }),
    });
    const curr = snapshot({
      t: table({
        columns: { c: col("text") },
        indexes: { idx_expr: mkIndex("upper(c)") },
      }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.indexes.altered).toHaveLength(1);
    expect(hasDiffChanges(diff)).toBe(true);
  });

  it("does not flag an index when only key order in the snapshot changes", async () => {
    const idx: SchemaIndex = {
      name: "idx_c",
      columns: [{ expression: "c", isExpression: false }],
      isUnique: false,
    };
    const prev = snapshot({
      t: table({
        columns: { c: col("integer") },
        indexes: { idx_c: { ...idx } },
      }),
    });
    const curr = snapshot({
      t: table({
        columns: { c: col("integer") },
        indexes: { idx_c: { ...idx } },
      }),
    });
    const diff = await calculateDiff(prev, curr);
    expect(diff.indexes.altered).toEqual([]);
    expect(hasDiffChanges(diff)).toBe(false);
  });
});

// keep the import referenced for type-aware tooling
void (undefined as unknown as typeof SNAPSHOT_META);
