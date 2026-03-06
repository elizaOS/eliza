/**
 * MySQL dialect adapter for buildTable().
 *
 * Maps abstract SchemaColumn types to drizzle-orm/mysql-core column builders.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  float,
  foreignKey,
  index,
  int,
  json,
  mysqlTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { logger, type SchemaColumn } from "@elizaos/core";
import type { DialectAdapter } from "./types.ts";

/**
 * Custom MySQL type for native VECTOR columns.
 * MySQL 9.0+ supports VECTOR(N) for storing embeddings.
 * Inlined from plugin-mysql to avoid circular dependency.
 */
function mysqlVectorNative(name: string, dimensions: number) {
  return customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return JSON.stringify(value);
    },
    fromDriver(value: string): number[] {
      if (typeof value === "string") {
        return JSON.parse(value);
      }
      if (Array.isArray(value)) {
        return value;
      }
      return [];
    },
  })(name);
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function buildMysqlColumn(col: SchemaColumn): any {
  const t = col.type.toLowerCase();
  let b: any;

  if (t.startsWith("varchar")) {
    const m = t.match(/varchar\((\d+)\)/);
    b = varchar(col.name, { length: m ? Number.parseInt(m[1], 10) : 255 });
  } else if (t === "text[]") {
    // MySQL has no array columns — store as JSON
    b = json(col.name);
  } else if (t === "text") {
    b = text(col.name);
  } else if (t === "integer") {
    b = int(col.name);
  } else if (t === "real[]") {
    // MySQL has no array columns — store as JSON
    b = json(col.name);
  } else if (t === "real") {
    b = float(col.name);
  } else if (t === "jsonb" || t === "json") {
    b = json(col.name);
  } else if (t === "boolean") {
    b = boolean(col.name);
  } else if (t === "timestamp") {
    b = timestamp(col.name);
  } else if (t.startsWith("vector")) {
    const m = t.match(/vector\((\d+)\)/);
    const dimensions = m ? Number.parseInt(m[1], 10) : 384;
    b = mysqlVectorNative(col.name, dimensions);
  } else if (t === "uuid") {
    // MySQL has no native UUID type — use varchar(36)
    b = varchar(col.name, { length: 36 });
  } else {
    b = text(col.name);
  }

  if (col.primaryKey) b = b.primaryKey();
  if (col.notNull) b = b.notNull();

  if (col.default !== undefined) {
    const defaultStr = String(col.default);
    if (defaultStr === "now()") {
      b = b.default(sql`CURRENT_TIMESTAMP`);
    } else if (defaultStr === "gen_random_uuid()" || defaultStr === "defaultRandom()") {
      // Skip UUID defaults for MySQL - app generates UUIDs via crypto.randomUUID()
      // Don't add a default clause
    } else if ((defaultStr === "[]" && t === "text[]") || (defaultStr === "{}" && (t === "jsonb" || t === "json"))) {
      // MySQL stores arrays/objects as JSON - default to empty JSON array/object
      b = b.default(sql`('${defaultStr}')`);
    } else {
      b = b.default(col.default);
    }
  }

  return b;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

export const mysqlAdapter: DialectAdapter = {
  createTable: mysqlTable,
  buildColumn: buildMysqlColumn,
  buildIndex: index,
  buildUniqueIndex: uniqueIndex,
  buildUniqueConstraint: (name: string, nullsNotDistinct?: boolean) => {
    return (columns: any[]) => {
      if (nullsNotDistinct) {
        // MySQL doesn't support NULLS NOT DISTINCT — NULLs are always distinct in unique constraints.
        // Multiple NULL values are allowed by default, so the constraint still works for our use case.
        logger.debug(
          { src: "plugin:sql:schema-builder", constraint: name },
          "MySQL doesn't support NULLS NOT DISTINCT. NULLs will be treated as distinct (multiple NULLs allowed).",
        );
      }
      return unique(name).on(...(columns as [any, ...any[]]));
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
    options?: { method?: string; opClass?: string; isUnique?: boolean },
  ) => {
    // MySQL doesn't support GIN indexes or PostgreSQL-specific index methods
    // Create a regular B-tree index on the column or expression
    const builder = options?.isUnique ? uniqueIndex(name) : index(name);

    if (options?.method === "gin") {
      // MySQL doesn't support GIN indexes — create a regular B-tree index instead.
      // WHY: JSONB containment queries use JSON_CONTAINS() which doesn't benefit from
      // standard B-tree indexes, but having an index for equality lookups is still better than none.
      logger.debug(
        { src: "plugin:sql:schema-builder", index: name, method: options.method },
        "MySQL doesn't support GIN indexes. Creating regular B-tree index instead.",
      );
    }

    // MySQL supports expression indexes (on computed columns) in MySQL 8.0.13+
    // For JSON path expressions like ((metadata->>'type')), use raw SQL
    // The expression can be a SQL template or a column reference
    return builder.on(exprOrColumn);
  },
  translateExpression: (expr: string): string => {
    let result = expr;

    // Order matters: ->> must be replaced before -> to avoid partial matches.

    // PG: col->>'key'  →  MySQL: JSON_UNQUOTE(JSON_EXTRACT(col, '$.key'))
    // Matches: metadata->>'type', metadata->>'documentId', etc.
    result = result.replace(
      /(\w+)->>'\s*([^']+)\s*'/g,
      "JSON_UNQUOTE(JSON_EXTRACT($1, '$.$2'))",
    );

    // PG: col->'key'  →  MySQL: JSON_EXTRACT(col, '$.key')
    result = result.replace(
      /(\w+)->'([^']+)'/g,
      "JSON_EXTRACT($1, '$.$2')",
    );

    // PG: col ? 'key'  →  MySQL: JSON_CONTAINS_PATH(col, 'one', '$.key')
    // The ? operator checks for key existence in JSONB.
    result = result.replace(
      /(\w+)\s*\?\s*'([^']+)'/g,
      "JSON_CONTAINS_PATH($1, 'one', '$.$2')",
    );

    return result;
  },
};
