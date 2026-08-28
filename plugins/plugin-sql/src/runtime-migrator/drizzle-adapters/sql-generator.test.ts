import { describe, expect, it } from "vitest";
import type { SchemaDiff } from "./diff-calculator";
import { checkForDataLoss } from "./sql-generator";

function emptyDiff(): SchemaDiff {
  return {
    tables: { created: [], deleted: [], modified: [] },
    columns: { added: [], deleted: [], modified: [] },
    indexes: { created: [], deleted: [], altered: [] },
    foreignKeys: { created: [], deleted: [], altered: [] },
    uniqueConstraints: { created: [], deleted: [] },
    checkConstraints: { created: [], deleted: [] },
  };
}

function typeChange(from: string, to: string): SchemaDiff {
  const diff = emptyDiff();
  diff.columns.modified.push({
    table: "users",
    column: "count",
    changes: {
      typeChanged: true,
      prevType: from,
      newType: to,
      from: { name: "count", type: from },
      to: { name: "count", type: to },
    },
  });
  return diff;
}

describe("checkForDataLoss type-change classification", () => {
  it("treats equivalent integer spellings as non-destructive (int vs integer)", () => {
    const result = checkForDataLoss(typeChange("int", "integer"));
    expect(result.hasDataLoss).toBe(false);
    expect(result.typeChanges).toEqual([]);
  });

  it("treats int4/int8/int2 spellings as non-destructive", () => {
    expect(checkForDataLoss(typeChange("int4", "integer")).hasDataLoss).toBe(false);
    expect(checkForDataLoss(typeChange("int8", "bigint")).hasDataLoss).toBe(false);
    expect(checkForDataLoss(typeChange("int2", "smallint")).hasDataLoss).toBe(false);
  });

  it("treats bool as non-destructive vs boolean", () => {
    const result = checkForDataLoss(typeChange("bool", "boolean"));
    expect(result.hasDataLoss).toBe(false);
    expect(result.typeChanges).toEqual([]);
  });

  it("treats float8/float4 as non-destructive", () => {
    expect(checkForDataLoss(typeChange("float8", "double precision")).hasDataLoss).toBe(false);
    expect(checkForDataLoss(typeChange("float4", "real")).hasDataLoss).toBe(false);
  });

  it("treats precision-less numeric(p) as non-destructive vs numeric(p,0)", () => {
    const result = checkForDataLoss(typeChange("numeric(10)", "numeric(10,0)"));
    expect(result.hasDataLoss).toBe(false);
  });

  it("still flags genuinely destructive type changes (text -> integer)", () => {
    const result = checkForDataLoss(typeChange("text", "integer"));
    expect(result.hasDataLoss).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.typeChanges).toHaveLength(1);
    expect(result.typeChanges[0]).toMatchObject({
      table: "users",
      column: "count",
      from: "text",
      to: "integer",
    });
    expect(result.tablesToTruncate).toContain("users");
  });

  it("still flags narrowing integer -> smallint as destructive", () => {
    const result = checkForDataLoss(typeChange("integer", "smallint"));
    expect(result.hasDataLoss).toBe(true);
    expect(result.typeChanges).toHaveLength(1);
  });

  it("treats safe widening integer -> bigint as non-destructive", () => {
    const result = checkForDataLoss(typeChange("integer", "bigint"));
    expect(result.hasDataLoss).toBe(false);
  });

  it("treats varchar -> text as non-destructive", () => {
    const result = checkForDataLoss(typeChange("varchar", "text"));
    expect(result.hasDataLoss).toBe(false);
  });
});

describe("checkForDataLoss structural findings", () => {
  it("flags dropped tables as data loss", () => {
    const diff = emptyDiff();
    diff.tables.deleted.push("users");
    const result = checkForDataLoss(diff);
    expect(result.hasDataLoss).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.tablesToRemove).toContain("users");
    expect(result.warnings.some((w) => w.includes('Table "users"'))).toBe(true);
  });

  it("flags dropped columns as data loss", () => {
    const diff = emptyDiff();
    diff.columns.deleted.push({ table: "users", column: "email" });
    const result = checkForDataLoss(diff);
    expect(result.hasDataLoss).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.columnsToRemove).toContain("users.email");
  });

  it("flags NOT NULL added without default as a failure risk", () => {
    const diff = emptyDiff();
    diff.columns.modified.push({
      table: "users",
      column: "name",
      changes: {
        nullabilityChanged: true,
        wasNullable: true,
        isNullable: false,
        from: { name: "name", type: "text", notNull: false },
        to: { name: "name", type: "text", notNull: true },
      },
    });
    const result = checkForDataLoss(diff);
    expect(result.hasDataLoss).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  it("warns (but does not hard-fail) on added NOT NULL column without default", () => {
    const diff = emptyDiff();
    diff.columns.added.push({
      table: "users",
      column: "handle",
      definition: { name: "handle", type: "text", notNull: true },
    });
    const result = checkForDataLoss(diff);
    expect(result.hasDataLoss).toBe(false);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.warnings.some((w) => w.includes('"handle"'))).toBe(true);
  });

  it("returns a clean bill for an empty diff", () => {
    const result = checkForDataLoss(emptyDiff());
    expect(result.hasDataLoss).toBe(false);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("does not flag a type change with equal normalized types (timestamp variants)", () => {
    const result = checkForDataLoss(
      typeChange("timestamp with time zone", "timestamp without time zone")
    );
    expect(result.hasDataLoss).toBe(false);
  });
});
