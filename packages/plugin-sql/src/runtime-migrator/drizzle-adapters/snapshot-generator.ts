import { createHash } from 'crypto';
import { is, SQL } from 'drizzle-orm';
import { PgTable, getTableConfig, PgDialect, type PgColumn } from 'drizzle-orm/pg-core';
import type { SchemaSnapshot } from '../types';

/**
 * Utility functions from Drizzle's code
 */
function escapeSingleQuotes(str: string): string {
  return str.replace(/'/g, "''");
}

function isPgArrayType(sqlType: string): boolean {
  return sqlType.match(/.*\[\d*\].*|.*\[\].*/g) !== null;
}

function buildArrayString(array: any[], sqlType: string): string {
  sqlType = sqlType.split('[')[0];
  const values = array
    .map((value) => {
      if (typeof value === 'number' || typeof value === 'bigint') {
        return value.toString();
      } else if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
      } else if (Array.isArray(value)) {
        return buildArrayString(value, sqlType);
      } else if (value instanceof Date) {
        if (sqlType === 'date') {
          return `"${value.toISOString().split('T')[0]}"`;
        } else if (sqlType === 'timestamp') {
          return `"${value.toISOString().replace('T', ' ').slice(0, 23)}"`;
        } else {
          return `"${value.toISOString()}"`;
        }
      } else if (typeof value === 'object') {
        return `"${JSON.stringify(value).replaceAll('"', '\\"')}"`;
      }

      return `"${value}"`;
    })
    .join(',');

  return `{${values}}`;
}

const sqlToStr = (sql: SQL, casing: any) => {
  return sql.toQuery({
    escapeName: () => {
      throw new Error("we don't support params for `sql` default values");
    },
    escapeParam: () => {
      throw new Error("we don't support params for `sql` default values");
    },
    escapeString: () => {
      throw new Error("we don't support params for `sql` default values");
    },
    casing,
  }).sql;
};

/**
 * Extract Drizzle tables from a schema object
 */
function extractTablesFromSchema(schema: any): PgTable[] {
  const tables: PgTable[] = [];

  // Iterate through all exports in the schema
  const exports = Object.values(schema);
  exports.forEach((t: any) => {
    // Check if it's a PgTable using Drizzle's is() function
    if (is(t, PgTable)) {
      tables.push(t);
    }
  });

  return tables;
}

/**
 * Generate a snapshot from a Drizzle schema
 * This is a port of Drizzle's pgSerializer.generatePgSnapshot
 */
export async function generateSnapshot(schema: any): Promise<SchemaSnapshot> {
  const dialect = new PgDialect({ casing: undefined });
  const tables: any = {};
  const schemas: any = {};
  const enums: any = {};

  // Extract tables from schema
  const pgTables = extractTablesFromSchema(schema);

  // Process each table
  for (const table of pgTables) {
    const config = getTableConfig(table);
    const {
      name: tableName,
      columns,
      indexes,
      foreignKeys,
      schema: tableSchema,
      primaryKeys,
      uniqueConstraints,
      checks,
    } = config;

    const columnsObject: any = {};
    const indexesObject: any = {};
    const foreignKeysObject: any = {};
    const primaryKeysObject: any = {};
    const uniqueConstraintObject: any = {};
    const checksObject: any = {};

    // Process columns - EXACT copy of Drizzle's logic
    columns.forEach((column: PgColumn) => {
      const name = column.name;
      const notNull = column.notNull;
      const primaryKey = column.primary;
      const sqlType = column.getSQLType();
      const sqlTypeLowered = sqlType.toLowerCase();

      const columnToSet: any = {
        name,
        type: sqlType,
        primaryKey,
        notNull,
      };

      // Handle defaults - EXACT copy from Drizzle's pgSerializer.ts lines 247-273
      if (column.default !== undefined) {
        if (is(column.default, SQL)) {
          columnToSet.default = sqlToStr(column.default, undefined);
        } else {
          if (typeof column.default === 'string') {
            columnToSet.default = `'${escapeSingleQuotes(column.default)}'`;
          } else {
            if (sqlTypeLowered === 'jsonb' || sqlTypeLowered === 'json') {
              columnToSet.default = `'${JSON.stringify(column.default)}'::${sqlTypeLowered}`;
            } else if (column.default instanceof Date) {
              if (sqlTypeLowered === 'date') {
                columnToSet.default = `'${column.default.toISOString().split('T')[0]}'`;
              } else if (sqlTypeLowered === 'timestamp') {
                columnToSet.default = `'${column.default.toISOString().replace('T', ' ').slice(0, 23)}'`;
              } else {
                columnToSet.default = `'${column.default.toISOString()}'`;
              }
            } else if (isPgArrayType(sqlTypeLowered) && Array.isArray(column.default)) {
              columnToSet.default = `'${buildArrayString(column.default, sqlTypeLowered)}'`;
            } else {
              // Should do for all types
              // columnToSet.default = `'${column.default}'::${sqlTypeLowered}`;
              columnToSet.default = column.default;
            }
          }
        }
      }

      // Handle column-level unique constraints
      // IMPORTANT: Check isUnique, not just uniqueName presence!
      // Drizzle sets uniqueName for all columns but only unique ones should have constraints
      if ((column as any).isUnique && (column as any).config?.uniqueName) {
        uniqueConstraintObject[(column as any).config.uniqueName] = {
          name: (column as any).config.uniqueName,
          columns: [name],
          nullsNotDistinct: (column as any).config?.uniqueType === 'not distinct',
        };
      }

      columnsObject[name] = columnToSet;
    });

    // Process primary keys
    primaryKeys.forEach((pk: any) => {
      const columnNames = pk.columns.map((c: any) => c.name);
      const name = pk.getName();

      primaryKeysObject[name] = {
        name,
        columns: columnNames,
      };
    });

    // Process unique constraints
    uniqueConstraints?.forEach((unq: any) => {
      const columnNames = unq.columns.map((c: any) => c.name);
      const name = unq.name || `${tableName}_${columnNames.join('_')}_unique`;

      uniqueConstraintObject[name] = {
        name,
        columns: columnNames,
        nullsNotDistinct: unq.nullsNotDistinct,
      };
    });

    // Process foreign keys - includes both explicit foreignKeys and inline references
    // Drizzle's getTableConfig automatically collects inline .references() into foreignKeys
    foreignKeys.forEach((fk: any) => {
      const reference = fk.reference();
      const columnsFrom = reference.columns.map((it: any) => it.name);
      const columnsTo = reference.foreignColumns.map((it: any) => it.name);
      const tableTo = getTableConfig(reference.foreignTable).name;
      const schemaTo = getTableConfig(reference.foreignTable).schema || 'public';

      const name = fk.getName();

      foreignKeysObject[name] = {
        name,
        tableFrom: tableName,
        schemaFrom: tableSchema, // Add source table schema
        tableTo,
        schemaTo,
        columnsFrom,
        columnsTo,
        onDelete: fk.onDelete || 'no action',
        onUpdate: fk.onUpdate || 'no action',
      };
    });

    // Process indexes
    indexes.forEach((idx: any) => {
      const columns = idx.config.columns;
      const indexColumns = columns.map((col: any) => {
        if (is(col, SQL)) {
          return {
            expression: dialect.sqlToQuery(col).sql,
            isExpression: true,
          };
        } else {
          const indexCol: any = {
            expression: col.name,
            isExpression: false,
            asc: col.indexConfig?.order === 'asc',
          };
          // Only add nulls if explicitly specified in the config
          if (col.indexConfig?.nulls) {
            indexCol.nulls = col.indexConfig.nulls;
          }
          return indexCol;
        }
      });

      const name =
        idx.config.name ||
        `${tableName}_${indexColumns.map((c: any) => c.expression).join('_')}_index`;

      indexesObject[name] = {
        name,
        columns: indexColumns,
        isUnique: idx.config.unique || false,
        method: idx.config.method || 'btree',
      };
    });

    // Process check constraints
    if (checks) {
      checks.forEach((check: any) => {
        const checkName = check.name;
        checksObject[checkName] = {
          name: checkName,
          value: dialect.sqlToQuery(check.value).sql,
        };
      });
    }

    // Build the table object
    tables[`${tableSchema || 'public'}.${tableName}`] = {
      name: tableName,
      schema: tableSchema || 'public',
      columns: columnsObject,
      indexes: indexesObject,
      foreignKeys: foreignKeysObject,
      compositePrimaryKeys: primaryKeysObject,
      uniqueConstraints: uniqueConstraintObject,
      checkConstraints: checksObject,
    };

    // Track schemas
    if (tableSchema && tableSchema !== 'public') {
      schemas[tableSchema] = tableSchema;
    }
  }

  // Create snapshot in Drizzle's format
  const snapshot: SchemaSnapshot = {
    version: '7',
    dialect: 'postgresql',
    tables,
    schemas,
    enums,
    _meta: {
      schemas: {},
      tables: {},
      columns: {},
    },
  };

  return snapshot;
}

/**
 * Calculate hash of a snapshot for change detection
 */
export function hashSnapshot(snapshot: SchemaSnapshot): string {
  const content = JSON.stringify(snapshot);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Create an empty snapshot for initial migration
 */
export function createEmptySnapshot(): SchemaSnapshot {
  return {
    version: '7',
    dialect: 'postgresql',
    tables: {},
    schemas: {},
    enums: {},
    _meta: {
      schemas: {},
      tables: {},
      columns: {},
    },
  };
}

/**
 * Compare two snapshots and detect if there are changes
 */
export function hasChanges(
  previousSnapshot: SchemaSnapshot | null,
  currentSnapshot: SchemaSnapshot
): boolean {
  // If no previous snapshot, there are definitely changes
  if (!previousSnapshot) {
    return Object.keys(currentSnapshot.tables).length > 0;
  }

  // Simple comparison for now - in production, use deep comparison
  const prevHash = hashSnapshot(previousSnapshot);
  const currHash = hashSnapshot(currentSnapshot);

  return prevHash !== currHash;
}
