/**
 * Guards the Worker plugin-sql stub against schema drift (#13406). The
 * wrangler alias swaps @elizaos/plugin-sql for src/stubs/elizaos-plugin-sql.ts
 * at bundle time, so cloud-shared repositories typecheck against the REAL
 * schema but execute against the STUB — a drifted stub column (42703), a
 * wrong/phantom table name (42P01), or a column the stub simply lacks
 * (undefined drizzle ref) all surface only in the deployed Worker as 500s on
 * console page loads. Three mechanical invariants close that gap:
 *   1. every stub table exists upstream under the same export name,
 *   2. same SQL table name, stub columns ⊆ upstream columns (renames fail),
 *   3. every `<x>Table.<column>` property that cloud Worker source actually
 *      dereferences exists on the stub table (partial-stub gaps fail).
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as realSchema from "../../../../plugins/plugin-sql/src/schema/index";
import * as stubSchema from "../src/stubs/elizaos-plugin-sql";

function isPgTable(value: unknown): value is PgTable {
  return is(value, PgTable);
}

function tableExports(mod: Record<string, unknown>): Map<string, PgTable> {
  const tables = new Map<string, PgTable>();
  for (const [name, value] of Object.entries(mod)) {
    if (name.endsWith("Table") && isPgTable(value)) {
      tables.set(name, value);
    }
  }
  return tables;
}

const stubTables = tableExports(stubSchema as Record<string, unknown>);
const realTables = tableExports(realSchema as Record<string, unknown>);

describe("plugin-sql Worker stub mirrors the real schema", () => {
  test("stub exports at least the tables cloud-shared destructures", () => {
    expect(stubTables.size).toBeGreaterThan(0);
  });

  for (const [exportName, stubTable] of stubTables) {
    test(`${exportName}: same table name and no drifted columns`, () => {
      const realTable = realTables.get(exportName);
      expect(
        realTable,
        `stub exports ${exportName} but plugins/plugin-sql/src/schema does not — phantom table`,
      ).toBeDefined();
      if (!realTable) return;

      expect(getTableName(stubTable)).toBe(getTableName(realTable));

      // Compare property-key → SQL-name pairs: a stale SQL name is the #13495
      // 42703 class, and a mismatched property key means real-schema-typechecked
      // repo code dereferences `undefined` in the Worker bundle.
      const realColumns = getTableColumns(realTable);
      for (const [key, column] of Object.entries(getTableColumns(stubTable))) {
        const realColumn = realColumns[key];
        expect(
          realColumn,
          `${exportName}.${key} is not a column of the real ${getTableName(realTable)} table — renamed or removed upstream (the #13495 drift class)`,
        ).toBeDefined();
        expect(
          realColumn?.name,
          `${exportName}.${key} maps to "${column.name}" in the stub but "${realColumn?.name}" upstream`,
        ).toBe(column.name);
      }
    });
  }

  test("every eliza-table column referenced by Worker source exists on the stub", () => {
    // Walk the source that ends up in the Worker bundle: cloud-shared src and
    // this package's route tree + src (minus the stubs themselves and tests).
    const apiRoot = resolve(import.meta.dir, "..");
    const roots = [resolve(apiRoot, "../shared/src"), apiRoot];
    const skipDirs = new Set([
      "node_modules",
      "__tests__",
      "test",
      "stubs",
      "migrations",
      "dist",
      ".turbo",
      ".wrangler",
    ]);

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (skipDirs.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (
          entry.endsWith(".ts") &&
          !entry.endsWith(".test.ts") &&
          !entry.endsWith(".d.ts")
        ) {
          files.push(full);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(files.length).toBeGreaterThan(0);

    const columnKeysByTable = new Map<string, Set<string>>();
    for (const [exportName, table] of stubTables) {
      columnKeysByTable.set(
        exportName,
        new Set(Object.keys(getTableColumns(table))),
      );
    }

    const missing: string[] = [];
    const reference = /\b(\w+Table)\.(\w+)\b/g;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(reference)) {
        const [, tableName, property] = match;
        const columns = columnKeysByTable.get(tableName);
        // Only tables the stub stands in for; other *Table identifiers are
        // unrelated (cloud-only tables, local variables).
        if (!columns) continue;
        // Non-column drizzle surface (e.g. `_`, `enableRLS`) never appears in
        // repo query code for these tables; a miss here means the stub lacks
        // a column the bundled Worker will dereference as `undefined`.
        if (!columns.has(property)) {
          missing.push(`${tableName}.${property} (${file})`);
        }
      }
    }

    expect(
      missing,
      `Worker source dereferences eliza-table columns the stub does not declare:\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
