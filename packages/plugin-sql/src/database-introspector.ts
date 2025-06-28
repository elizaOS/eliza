import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { logger } from '@elizaos/core';

type DrizzleDB = NodePgDatabase | PgliteDatabase;

export interface DatabaseColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: string;
  isPrimaryKey: boolean;
  isUnique: boolean;
  characterMaximumLength?: number;
  numericPrecision?: number;
  numericScale?: number;
}

export interface DatabaseIndex {
  name: string;
  columns: string[];
  unique: boolean;
  type: 'btree' | 'hash' | 'gin' | 'gist' | 'spgist' | 'brin';
  isPrimary: boolean;
}

export interface DatabaseForeignKey {
  name: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
  onDelete?: string;
  onUpdate?: string;
}

export interface DatabaseCheckConstraint {
  name: string;
  expression: string;
}

export interface DatabaseTable {
  name: string;
  schema: string;
  columns: DatabaseColumn[];
  indexes: DatabaseIndex[];
  foreignKeys: DatabaseForeignKey[];
  checkConstraints: DatabaseCheckConstraint[];
  primaryKey?: { name: string; columns: string[] };
}

/**
 * DatabaseIntrospector provides detailed database schema inspection capabilities
 * for both PostgreSQL and PGLite databases. It can analyze existing tables,
 * columns, indexes, foreign keys, and constraints to enable schema diff operations.
 */
export class DatabaseIntrospector {
  constructor(private db: DrizzleDB) {}

  /**
   * Introspects a complete table definition including all metadata
   */
  async introspectTable(schemaName: string, tableName: string): Promise<DatabaseTable> {
    const [columns, indexes, foreignKeys, checkConstraints, primaryKey] = await Promise.all([
      this.introspectColumns(schemaName, tableName),
      this.introspectIndexes(schemaName, tableName),
      this.introspectForeignKeys(schemaName, tableName),
      this.introspectCheckConstraints(schemaName, tableName),
      this.introspectPrimaryKey(schemaName, tableName),
    ]);

    return {
      name: tableName,
      schema: schemaName,
      columns,
      indexes,
      foreignKeys,
      checkConstraints,
      primaryKey,
    };
  }

  /**
   * Introspects all tables in a given schema
   */
  async introspectSchema(schemaName: string): Promise<Map<string, DatabaseTable>> {
    const tables = new Map<string, DatabaseTable>();

    try {
      const tableNames = await this.getTableNames(schemaName);

      for (const tableName of tableNames) {
        try {
          const table = await this.introspectTable(schemaName, tableName);
          tables.set(tableName, table);
        } catch (error) {
          logger.warn(`Failed to introspect table ${schemaName}.${tableName}:`, error);
        }
      }
    } catch (error) {
      logger.error(`Failed to introspect schema ${schemaName}:`, error);
    }

    return tables;
  }

  /**
   * Gets all table names in a schema
   */
  private async getTableNames(schemaName: string): Promise<string[]> {
    try {
      const result = await this.db.execute(
        sql.raw(`
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = '${schemaName}' 
          AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `)
      );
      return (result.rows as any[]).map((row) => row.table_name);
    } catch (error) {
      logger.error(`Failed to get table names for schema ${schemaName}:`, error);
      return [];
    }
  }

  /**
   * Introspects column definitions for a table
   */
  async introspectColumns(schemaName: string, tableName: string): Promise<DatabaseColumn[]> {
    try {
      const result = await this.db.execute(
        sql.raw(`
          SELECT 
            column_name,
            data_type,
            character_maximum_length,
            numeric_precision,
            numeric_scale,
            is_nullable,
            column_default,
            is_identity,
            identity_generation
          FROM information_schema.columns
          WHERE table_schema = '${schemaName}' AND table_name = '${tableName}'
          ORDER BY ordinal_position
        `)
      );

      const columns: DatabaseColumn[] = [];

      for (const row of result.rows as any[]) {
        const column: DatabaseColumn = {
          name: row.column_name,
          type: this.normalizeDataType(row.data_type, row),
          nullable: row.is_nullable === 'YES',
          defaultValue: row.column_default,
          isPrimaryKey: false, // Will be set when we check primary keys
          isUnique: false, // Will be set when we check unique constraints
          characterMaximumLength: row.character_maximum_length,
          numericPrecision: row.numeric_precision,
          numericScale: row.numeric_scale,
        };
        columns.push(column);
      }

      // Mark primary key columns
      const primaryKey = await this.introspectPrimaryKey(schemaName, tableName);
      if (primaryKey) {
        for (const column of columns) {
          if (primaryKey.columns.includes(column.name)) {
            column.isPrimaryKey = true;
          }
        }
      }

      // Mark unique columns
      const indexes = await this.introspectIndexes(schemaName, tableName);
      for (const index of indexes) {
        if (index.unique && index.columns.length === 1) {
          const column = columns.find((c) => c.name === index.columns[0]);
          if (column) {
            column.isUnique = true;
          }
        }
      }

      return columns;
    } catch (error) {
      logger.error(`Failed to introspect columns for ${schemaName}.${tableName}:`, error);
      return [];
    }
  }

  /**
   * Introspects indexes for a table
   */
  async introspectIndexes(schemaName: string, tableName: string): Promise<DatabaseIndex[]> {
    try {
      const result = await this.db.execute(
        sql.raw(`
          SELECT 
            i.relname as index_name,
            array_agg(a.attname ORDER BY a.attnum) as column_names,
            ix.indisunique as is_unique,
            ix.indisprimary as is_primary,
            am.amname as index_type
          FROM pg_index ix
          JOIN pg_class t ON t.oid = ix.indrelid
          JOIN pg_class i ON i.oid = ix.indexrelid
          JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
          JOIN pg_namespace n ON n.oid = t.relnamespace
          JOIN pg_am am ON am.oid = i.relam
          WHERE n.nspname = '${schemaName}' AND t.relname = '${tableName}'
          GROUP BY i.relname, ix.indisunique, ix.indisprimary, am.amname
          ORDER BY i.relname
        `)
      );

      return (result.rows as any[]).map((row) => ({
        name: row.index_name,
        columns: Array.isArray(row.column_names) ? row.column_names : [row.column_names],
        unique: row.is_unique,
        type: this.normalizeIndexType(row.index_type),
        isPrimary: row.is_primary,
      }));
    } catch (error) {
      // Fallback for PGLite or other databases that might not support these queries
      logger.debug(
        `Advanced index introspection failed for ${schemaName}.${tableName}, using fallback:`,
        error
      );
      return this.introspectIndexesFallback(schemaName, tableName);
    }
  }

  /**
   * Fallback method for index introspection when advanced queries fail
   */
  private async introspectIndexesFallback(
    schemaName: string,
    tableName: string
  ): Promise<DatabaseIndex[]> {
    try {
      const result = await this.db.execute(
        sql.raw(`
          SELECT 
            constraint_name,
            constraint_type
          FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName}' AND table_name = '${tableName}'
          AND constraint_type IN ('UNIQUE', 'PRIMARY KEY')
        `)
      );

      const indexes: DatabaseIndex[] = [];

      for (const row of result.rows as any[]) {
        // Get columns for this constraint
        const columnResult = await this.db.execute(
          sql.raw(`
            SELECT column_name
            FROM information_schema.key_column_usage
            WHERE constraint_schema = '${schemaName}' 
            AND table_name = '${tableName}'
            AND constraint_name = '${row.constraint_name}'
            ORDER BY ordinal_position
          `)
        );

        const columns = (columnResult.rows as any[]).map((r) => r.column_name);

        indexes.push({
          name: row.constraint_name,
          columns,
          unique: row.constraint_type === 'UNIQUE' || row.constraint_type === 'PRIMARY KEY',
          type: 'btree', // Default assumption
          isPrimary: row.constraint_type === 'PRIMARY KEY',
        });
      }

      return indexes;
    } catch (error) {
      logger.error(`Fallback index introspection failed for ${schemaName}.${tableName}:`, error);
      return [];
    }
  }

  /**
   * Introspects foreign keys for a table
   */
  async introspectForeignKeys(
    schemaName: string,
    tableName: string
  ): Promise<DatabaseForeignKey[]> {
    try {
      const result = await this.db.execute(
        sql.raw(`
          SELECT
            tc.constraint_name,
            array_agg(kcu.column_name ORDER BY kcu.ordinal_position) as column_names,
            ccu.table_schema AS foreign_table_schema,
            ccu.table_name AS foreign_table_name,
            array_agg(ccu.column_name ORDER BY kcu.ordinal_position) as foreign_column_names,
            rc.update_rule,
            rc.delete_rule
          FROM information_schema.table_constraints AS tc
          JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage AS ccu
            ON ccu.constraint_name = tc.constraint_name
            AND ccu.table_schema = tc.table_schema
          JOIN information_schema.referential_constraints AS rc
            ON rc.constraint_name = tc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY' 
            AND tc.table_schema = '${schemaName}' 
            AND tc.table_name = '${tableName}'
          GROUP BY tc.constraint_name, ccu.table_schema, ccu.table_name, rc.update_rule, rc.delete_rule
          ORDER BY tc.constraint_name
        `)
      );

      return (result.rows as any[]).map((row) => ({
        name: row.constraint_name,
        columns: Array.isArray(row.column_names) ? row.column_names : [row.column_names],
        referencedTable: row.foreign_table_name,
        referencedColumns: Array.isArray(row.foreign_column_names)
          ? row.foreign_column_names
          : [row.foreign_column_names],
        onDelete: row.delete_rule,
        onUpdate: row.update_rule,
      }));
    } catch (error) {
      logger.error(`Failed to introspect foreign keys for ${schemaName}.${tableName}:`, error);
      return [];
    }
  }

  /**
   * Introspects check constraints for a table
   */
  async introspectCheckConstraints(
    schemaName: string,
    tableName: string
  ): Promise<DatabaseCheckConstraint[]> {
    try {
      const result = await this.db.execute(
        sql.raw(`
          SELECT 
            constraint_name,
            check_clause
          FROM information_schema.check_constraints cc
          JOIN information_schema.table_constraints tc
            ON cc.constraint_name = tc.constraint_name
            AND cc.constraint_schema = tc.table_schema
          WHERE tc.table_schema = '${schemaName}' 
            AND tc.table_name = '${tableName}'
            AND tc.constraint_type = 'CHECK'
          ORDER BY constraint_name
        `)
      );

      return (result.rows as any[]).map((row) => ({
        name: row.constraint_name,
        expression: row.check_clause,
      }));
    } catch (error) {
      // PGLite may not support check constraints query - silently return empty
      logger.debug(`Check constraints query not supported for ${schemaName}.${tableName}, skipping`);
      return [];
    }
  }

  /**
   * Introspects primary key for a table
   */
  private async introspectPrimaryKey(
    schemaName: string,
    tableName: string
  ): Promise<{ name: string; columns: string[] } | undefined> {
    try {
      const result = await this.db.execute(
        sql.raw(`
          SELECT 
            tc.constraint_name,
            array_agg(kcu.column_name ORDER BY kcu.ordinal_position) as column_names
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = '${schemaName}'
            AND tc.table_name = '${tableName}'
          GROUP BY tc.constraint_name
        `)
      );

      if (result.rows.length > 0) {
        const row = result.rows[0] as any;
        return {
          name: row.constraint_name,
          columns: Array.isArray(row.column_names) ? row.column_names : [row.column_names],
        };
      }

      return undefined;
    } catch (error) {
      logger.error(`Failed to introspect primary key for ${schemaName}.${tableName}:`, error);
      return undefined;
    }
  }

  /**
   * Normalizes PostgreSQL data types to a standard format
   */
  private normalizeDataType(dataType: string, row: any): string {
    switch (dataType.toLowerCase()) {
      case 'character varying':
        return row.character_maximum_length
          ? `VARCHAR(${row.character_maximum_length})`
          : 'VARCHAR';
      case 'character':
        return row.character_maximum_length ? `CHAR(${row.character_maximum_length})` : 'CHAR';
      case 'timestamp without time zone':
        return 'TIMESTAMP';
      case 'timestamp with time zone':
        return 'TIMESTAMP WITH TIME ZONE';
      case 'double precision':
        return 'DOUBLE PRECISION';
      case 'user-defined':
        // Check if it's a vector type or other custom type
        return this.handleUserDefinedType(row);
      default:
        return dataType.toUpperCase();
    }
  }

  /**
   * Handles user-defined types like vector
   */
  private handleUserDefinedType(row: any): string {
    // For vector types, we might need additional queries to get the dimension
    // For now, return the raw type name
    return row.data_type || 'TEXT';
  }

  /**
   * Normalizes index types
   */
  private normalizeIndexType(
    indexType: string
  ): 'btree' | 'hash' | 'gin' | 'gist' | 'spgist' | 'brin' {
    switch (indexType.toLowerCase()) {
      case 'btree':
        return 'btree';
      case 'hash':
        return 'hash';
      case 'gin':
        return 'gin';
      case 'gist':
        return 'gist';
      case 'spgist':
        return 'spgist';
      case 'brin':
        return 'brin';
      default:
        return 'btree'; // Default fallback
    }
  }
}
