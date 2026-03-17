/**
 * PostgreSQL dialect adapter for buildTable().
 *
 * Maps abstract SchemaColumn types to drizzle-orm/pg-core column builders.
 */

import type { SchemaColumn } from "@elizaos/core";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
  vector,
} from "drizzle-orm/pg-core";
import type { DialectAdapter } from "./types.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

function buildPgColumn(col: SchemaColumn): any {
  const t = col.type.toLowerCase();
  let b: any;

  if (t.startsWith("varchar")) {
    const m = t.match(/varchar\((\d+)\)/);
    b = varchar(col.name, { length: m ? Number.parseInt(m[1], 10) : 255 });
  } else if (t === "text[]") {
    b = text(col.name).array();
  } else if (t === "text") {
    b = text(col.name);
  } else if (t === "integer") {
    b = integer(col.name);
  } else if (t === "real[]") {
    b = real(col.name).array();
  } else if (t === "real") {
    b = real(col.name);
  } else if (t === "jsonb") {
    b = jsonb(col.name);
  } else if (t === "boolean") {
    b = boolean(col.name);
  } else if (t === "timestamp") {
    b = timestamp(col.name);
  } else if (t.startsWith("vector")) {
    const m = t.match(/vector\((\d+)\)/);
    const dimensions = m ? Number.parseInt(m[1], 10) : 384;
    b = vector(col.name, { dimensions });
  } else if (t === "uuid") {
    b = uuid(col.name);
  } else {
    b = text(col.name);
  }

  if (col.primaryKey) b = b.primaryKey();
  if (col.notNull) b = b.notNull();

  if (col.default !== undefined) {
    const defaultStr = String(col.default);
    if (defaultStr === "now()") {
      b = b.default(sql`now()`);
    } else if (defaultStr === "gen_random_uuid()") {
      b = b.default(sql`gen_random_uuid()`);
    } else if (defaultStr === "defaultRandom()" && t === "uuid") {
      // Drizzle sugar for client-side UUID generation
      b = b.defaultRandom();
    } else if (defaultStr === "[]" && t === "text[]") {
      // Empty array default for text[] columns - use PostgreSQL array literal syntax
      b = b.default(sql`'{}'`);
    } else if (defaultStr === "{}" && t === "jsonb") {
      // Empty object default for jsonb columns
      b = b.default(sql`'{}'::jsonb`);
    } else {
      b = b.default(col.default);
    }
  }

  return b;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

export const pgAdapter: DialectAdapter = {
  createTable: pgTable,
  buildColumn: buildPgColumn,
  buildIndex: index,
  buildUniqueIndex: uniqueIndex,
  buildUniqueConstraint: (name: string, nullsNotDistinct?: boolean) => {
    return (columns: any[]) => {
      const cols = columns as [any, ...any[]];
      if (nullsNotDistinct) {
        // Drizzle's unique() with nulls: 'not distinct' option for PostgreSQL 15+
        return unique(name)
          .on(...cols)
          .nullsNotDistinct();
      }
      return unique(name).on(...cols);
    };
  },
  buildForeignKey: (name: string, onUpdate?: string, onDelete?: string) => {
    return (columns: any[], _targetTable: any, targetColumns: any[]) => {
      // foreignKey() infers the target table from foreignColumns[0].table
      // so we don't need the targetTable parameter
      const fk = foreignKey({
        name,
        columns: columns as [any, ...any[]],
        foreignColumns: targetColumns as [any, ...any[]],
      });
      if (onUpdate) fk.onUpdate(onUpdate as any);
      if (onDelete) fk.onDelete(onDelete as any);
      return fk;
    };
  },
  buildCheckConstraint: (name: string) => {
    return (expr: any) => check(name, expr);
  },
  buildExpressionIndex: (
    name: string,
    exprOrColumn: any,
    options?: { method?: string; opClass?: string; isUnique?: boolean }
  ) => {
    const builder = options?.isUnique ? uniqueIndex(name) : index(name);

    // Detect if this is a SQL expression object or a column reference
    // SQL objects have .getSQL() method; column refs don't (but have .op())
    const isSqlExpression =
      typeof exprOrColumn === "object" &&
      "getSQL" in exprOrColumn &&
      typeof exprOrColumn.getSQL === "function";

    if (options?.method === "gin") {
      if (options?.opClass && !isSqlExpression) {
        // Column reference with operator class:
        // Use Drizzle's .op() method on the column, then pass to .using()
        // e.g., index().using("gin", column.op("jsonb_path_ops"))
        // Ref: https://orm.drizzle.team/docs/indexes-constraints
        return builder.using("gin", exprOrColumn.op(options.opClass));
      }
      // SQL expression or column without opClass - pass directly
      return builder.using("gin", exprOrColumn);
    } else if (options?.method) {
      // Other index methods (gist, hash, brin, etc.)
      return builder.using(options.method, exprOrColumn);
    }

    // No method specified - regular B-tree index with .on()
    // Works for both column references and SQL expressions
    return builder.on(exprOrColumn);
  },
};
