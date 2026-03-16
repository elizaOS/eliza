/**
 * Schema builders — convert abstract SchemaTable definitions into
 * ORM-specific table objects via a DialectAdapter.
 *
 * Usage:
 *   import { buildTable, pgAdapter } from "./schema-builders";
 *   const table = buildTable(mySchema, pgAdapter);
 */
import type { SchemaTable } from "@elizaos/core";
import { sql } from "drizzle-orm";
import type { DialectAdapter } from "./types.ts";
import { snakeToCamel } from "./types.ts";

export { mysqlAdapter } from "./mysql.ts";
export { pgAdapter } from "./pg.ts";
export { snakeToCamel } from "./types.ts";
export type { DialectAdapter } from "./types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Convert an abstract SchemaTable into a concrete ORM table object.
 *
 * The function itself has no dialect knowledge — all type mapping and
 * table/index/constraint construction is delegated to the provided adapter.
 *
 * Column keys are converted from snake_case (DB column names) to camelCase
 * (JS property names) so that query-builder code like
 * `eq(table.agentId, value)` keeps working.
 */
export function buildTable(schema: SchemaTable, adapter: DialectAdapter): any {
  const columns: Record<string, any> = {};
  for (const col of Object.values(schema.columns)) {
    columns[snakeToCamel(col.name)] = adapter.buildColumn(col);
  }

  // Dialect-specific expression translator. Converts canonical (PG) SQL
  // syntax to the dialect's native syntax before wrapping in sql.raw().
  // PG adapter doesn't implement this (pass-through); MySQL adapter
  // translates JSON operators (->>, ->, ?) to their MySQL equivalents.
  const xlate = adapter.translateExpression
    ? (expr: string) => adapter.translateExpression!(expr)
    : (expr: string) => expr;

  return adapter.createTable(schema.name, columns, (table: any) => {
    const constraints: any[] = [];

    // ========================================
    // 1. Build column-based indexes
    // ========================================
    for (const idx of Object.values(schema.indexes)) {
      const hasExpressions = idx.columns.some((c) => c.isExpression);
      
      if (!hasExpressions) {
        // Pure column-based index (no expressions)
        const cols = idx.columns.map((c) => table[snakeToCamel(c.expression)]);
        const builder = idx.isUnique && adapter.buildUniqueIndex
          ? adapter.buildUniqueIndex
          : adapter.buildIndex;
        const idxBuilder = builder(idx.name);
        constraints.push(idxBuilder.on(...(cols as [any, ...any[]])));
      } else if (adapter.buildExpressionIndex) {
        // Expression-based index
        // Two cases:
        // A) Simple: "column_name operator_class" (e.g., "data jsonb_path_ops")
        //    → Use table[column].op(opClass) for proper Drizzle integration
        // B) Complex: Full SQL expression (e.g., "((metadata->>'type'))")
        //    → Translate via xlate(), then wrap in sql.raw()

        if (idx.columns.length === 1 && idx.columns[0].isExpression) {
          const exprCol = idx.columns[0];
          const expr = exprCol.expression.trim();

          // Check if it's a simple "column opclass" format
          const parts = expr.split(/\s+/);
          const isSimpleColumnOpClass = parts.length === 2 && !expr.includes('(');
          
          if (isSimpleColumnOpClass) {
            // Simple case: "data jsonb_path_ops"
            const columnName = parts[0];
            const opClass = parts[1];
            const column = table[snakeToCamel(columnName)];
            
            if (column) {
              constraints.push(
                adapter.buildExpressionIndex(
                  idx.name,
                  column,
                  {
                    method: idx.method,
                    opClass,
                    isUnique: idx.isUnique,
                  },
                )
              );
            }
          } else {
            // Complex case: Full SQL expression like "((metadata->>'type'))"
            constraints.push(
              adapter.buildExpressionIndex(
                idx.name,
                sql.raw(xlate(expr)),
                {
                  method: idx.method,
                  isUnique: idx.isUnique,
                },
              )
            );
          }
        } else if (idx.columns.length > 1 && hasExpressions) {
          // Multi-column expression index (e.g., idx_fragments_order with two JSONB paths)
          // Build each column/expression, then pass all to .on()
          const columnRefs = idx.columns.map((c) => {
            if (c.isExpression) {
              return sql.raw(xlate(c.expression.trim()));
            } else {
              return table[snakeToCamel(c.expression)];
            }
          });

          // Use buildIndex (not buildExpressionIndex) for multi-column
          // because buildExpressionIndex expects a single expression
          const multiBuilder = idx.isUnique && adapter.buildUniqueIndex
            ? adapter.buildUniqueIndex
            : adapter.buildIndex;
          const multiIdxBuilder = multiBuilder(idx.name);
          constraints.push(
            multiIdxBuilder.on(...(columnRefs as [any, ...any[]]))
          );
        }
      }
    }

    // ========================================
    // 2. Build unique constraints
    // ========================================
    if (schema.uniqueConstraints && adapter.buildUniqueConstraint) {
      for (const constraint of Object.values(schema.uniqueConstraints)) {
        const cols = constraint.columns.map((colName) =>
          table[snakeToCamel(colName)]
        );
        const constraintBuilder = adapter.buildUniqueConstraint(
          constraint.name,
          constraint.nullsNotDistinct,
        );
        constraints.push(constraintBuilder(cols));
      }
    }

    // ========================================
    // 3. Build foreign keys
    // ========================================
    // DESIGN DECISION: Foreign keys are NOT created in buildTable().
    // 
    // WHY: FKs require references to target table objects (e.g., agentTable.id),
    // but buildTable() is called once per table. When building the "memories" table,
    // the "agents" table doesn't exist yet. We can't use lazy functions (() => targetTable)
    // because we don't have a registry of all tables at this point.
    // 
    // HOW FKs ARE CREATED: The RuntimeMigrator reads foreign key definitions from
    // the abstract schemas (schema.foreignKeys), which use string-based table references.
    // It generates ALTER TABLE statements to add FKs AFTER all tables exist.
    // 
    // ALTERNATIVE: Define FKs inline with .references() on columns in buildColumn(),
    // but this requires passing a table resolver to buildColumn(), adding complexity
    // for minimal benefit since the migrator already handles it.

    // ========================================
    // 4. Build check constraints
    // ========================================
    if (schema.checkConstraints && adapter.buildCheckConstraint) {
      for (const chk of Object.values(schema.checkConstraints)) {
        const constraintBuilder = adapter.buildCheckConstraint(chk.name);
        constraints.push(constraintBuilder(sql.raw(xlate(chk.value))));
      }
    }

    return constraints;
  });
}

/* eslint-enable @typescript-eslint/no-explicit-any */
