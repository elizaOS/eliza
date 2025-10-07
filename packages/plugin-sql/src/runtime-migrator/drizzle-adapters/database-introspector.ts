import { sql } from 'drizzle-orm';
import { logger } from '@elizaos/core';
import type { DrizzleDB, SchemaSnapshot } from '../types';

/**
 * Introspect the current database state and generate a snapshot
 * This is used when no previous snapshot exists for a plugin
 * to capture the existing database state before migrations
 */
export class DatabaseIntrospector {
  constructor(private db: DrizzleDB) {}

  /**
   * Introspect all tables in the database and generate a snapshot
   * @param schemaName - Schema to introspect (default: 'public')
   * @returns Schema snapshot of current database state
   */
  async introspectSchema(schemaName: string = 'public'): Promise<SchemaSnapshot> {
    logger.info(`[DatabaseIntrospector] Starting introspection for schema: ${schemaName}`);

    const tables: any = {};
    const schemas: any = {};
    const enums: any = {};

    // Get all tables in the schema
    const allTables = await this.getTables(schemaName);

    for (const tableInfo of allTables) {
      const tableName = tableInfo.table_name;
      const tableSchema = tableInfo.table_schema || 'public';

      logger.debug(`[DatabaseIntrospector] Introspecting table: ${tableSchema}.${tableName}`);

      // Get columns for this table
      const columns = await this.getColumns(tableSchema, tableName);
      const columnsObject: any = {};
      const uniqueConstraintObject: any = {};

      for (const col of columns) {
        columnsObject[col.column_name] = {
          name: col.column_name,
          type: col.data_type,
          primaryKey: col.is_primary || false,
          notNull: col.is_nullable === 'NO',
          default: col.column_default
            ? this.parseDefault(col.column_default, col.data_type)
            : undefined,
        };
      }

      // Get indexes
      const indexes = await this.getIndexes(tableSchema, tableName);
      const indexesObject: any = {};

      for (const idx of indexes) {
        if (!idx.is_primary && !idx.is_unique_constraint) {
          // Skip primary keys and unique constraints
          indexesObject[idx.name] = {
            name: idx.name,
            columns: idx.columns.map((col) => ({
              expression: col,
              isExpression: false,
            })),
            isUnique: idx.is_unique,
            method: idx.method || 'btree',
          };
        }
      }

      // Get foreign keys
      const foreignKeys = await this.getForeignKeys(tableSchema, tableName);
      const foreignKeysObject: any = {};

      for (const fk of foreignKeys) {
        foreignKeysObject[fk.name] = {
          name: fk.name,
          tableFrom: tableName,
          schemaFrom: tableSchema,
          tableTo: fk.foreign_table_name,
          schemaTo: fk.foreign_table_schema || 'public',
          columnsFrom: [fk.column_name],
          columnsTo: [fk.foreign_column_name],
          onDelete: fk.delete_rule?.toLowerCase() || 'no action',
          onUpdate: fk.update_rule?.toLowerCase() || 'no action',
        };
      }

      // Get primary keys
      const primaryKeys = await this.getPrimaryKeys(tableSchema, tableName);
      const primaryKeysObject: any = {};

      for (const pk of primaryKeys) {
        primaryKeysObject[pk.name] = {
          name: pk.name,
          columns: pk.columns,
        };
      }

      // Get unique constraints
      const uniqueConstraints = await this.getUniqueConstraints(tableSchema, tableName);

      for (const unq of uniqueConstraints) {
        uniqueConstraintObject[unq.name] = {
          name: unq.name,
          columns: unq.columns,
          nullsNotDistinct: false, // Default value
        };
      }

      // Get check constraints
      const checkConstraints = await this.getCheckConstraints(tableSchema, tableName);
      const checksObject: any = {};

      for (const check of checkConstraints) {
        checksObject[check.name] = {
          name: check.name,
          value: check.definition,
        };
      }

      // Build the table object
      tables[`${tableSchema}.${tableName}`] = {
        name: tableName,
        schema: tableSchema,
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

    // Get enums if any
    const enumsResult = await this.getEnums(schemaName);
    for (const enumInfo of enumsResult) {
      const key = `${enumInfo.schema}.${enumInfo.name}`;
      if (!enums[key]) {
        enums[key] = {
          name: enumInfo.name,
          schema: enumInfo.schema,
          values: [],
        };
      }
      enums[key].values.push(enumInfo.value);
    }

    logger.info(
      `[DatabaseIntrospector] Introspection complete. Found ${Object.keys(tables).length} tables`
    );

    return {
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
  }

  /**
   * Get all tables in a schema
   */
  private async getTables(schemaName: string): Promise<any[]> {
    const result = await this.db.execute(
      sql`SELECT 
            table_schema,
            table_name
          FROM information_schema.tables
          WHERE table_schema = ${schemaName}
            AND table_type = 'BASE TABLE'
          ORDER BY table_name`
    );
    return result.rows;
  }

  /**
   * Get columns for a table
   */
  private async getColumns(schemaName: string, tableName: string): Promise<any[]> {
    const result = await this.db.execute(
      sql`SELECT 
            a.attname AS column_name,
            CASE 
              WHEN a.attnotnull THEN 'NO'
              ELSE 'YES'
            END AS is_nullable,
            CASE 
              WHEN a.atttypid = ANY ('{int,int8,int2}'::regtype[]) 
              AND EXISTS (
                SELECT FROM pg_attrdef ad
                WHERE ad.adrelid = a.attrelid 
                AND ad.adnum = a.attnum 
                AND pg_get_expr(ad.adbin, ad.adrelid) = 'nextval(''' 
                    || pg_get_serial_sequence(a.attrelid::regclass::text, a.attname)::regclass || '''::regclass)'
              )
              THEN CASE a.atttypid
                WHEN 'int'::regtype THEN 'serial'
                WHEN 'int8'::regtype THEN 'bigserial'
                WHEN 'int2'::regtype THEN 'smallserial'
              END
              ELSE format_type(a.atttypid, a.atttypmod)
            END AS data_type,
            pg_get_expr(ad.adbin, ad.adrelid) AS column_default,
            CASE 
              WHEN con.contype = 'p' THEN true
              ELSE false
            END AS is_primary
          FROM pg_attribute a
          JOIN pg_class cls ON cls.oid = a.attrelid
          JOIN pg_namespace ns ON ns.oid = cls.relnamespace
          LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
          LEFT JOIN pg_constraint con ON con.conrelid = a.attrelid 
            AND a.attnum = ANY(con.conkey) 
            AND con.contype = 'p'
          WHERE 
            a.attnum > 0
            AND NOT a.attisdropped
            AND ns.nspname = ${schemaName}
            AND cls.relname = ${tableName}
          ORDER BY a.attnum`
    );
    return result.rows;
  }

  /**
   * Get indexes for a table
   */
  private async getIndexes(schemaName: string, tableName: string): Promise<any[]> {
    const result = await this.db.execute(
      sql`SELECT 
            i.relname AS name,
            idx.indisunique AS is_unique,
            idx.indisprimary AS is_primary,
            con.contype = 'u' AS is_unique_constraint,
            ARRAY(
              SELECT a.attname
              FROM pg_attribute a
              WHERE a.attrelid = idx.indrelid
                AND a.attnum = ANY(idx.indkey::int[])
              ORDER BY a.attnum
            ) AS columns,
            am.amname AS method
          FROM pg_index idx
          JOIN pg_class i ON i.oid = idx.indexrelid
          JOIN pg_class c ON c.oid = idx.indrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_am am ON am.oid = i.relam
          LEFT JOIN pg_constraint con ON con.conindid = idx.indexrelid
          WHERE n.nspname = ${schemaName}
            AND c.relname = ${tableName}`
    );
    return result.rows;
  }

  /**
   * Get foreign keys for a table
   */
  private async getForeignKeys(schemaName: string, tableName: string): Promise<any[]> {
    const result = await this.db.execute(
      sql`SELECT
            con.conname AS name,
            att.attname AS column_name,
            fnsp.nspname AS foreign_table_schema,
            frel.relname AS foreign_table_name,
            fatt.attname AS foreign_column_name,
            CASE con.confupdtype
              WHEN 'a' THEN 'NO ACTION'
              WHEN 'r' THEN 'RESTRICT'
              WHEN 'n' THEN 'SET NULL'
              WHEN 'c' THEN 'CASCADE'
              WHEN 'd' THEN 'SET DEFAULT'
            END AS update_rule,
            CASE con.confdeltype
              WHEN 'a' THEN 'NO ACTION'
              WHEN 'r' THEN 'RESTRICT'
              WHEN 'n' THEN 'SET NULL'
              WHEN 'c' THEN 'CASCADE'
              WHEN 'd' THEN 'SET DEFAULT'
            END AS delete_rule
          FROM pg_catalog.pg_constraint con
          JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
          JOIN pg_catalog.pg_namespace nsp ON nsp.oid = con.connamespace
          LEFT JOIN pg_catalog.pg_attribute att ON att.attnum = ANY (con.conkey)
            AND att.attrelid = con.conrelid
          LEFT JOIN pg_catalog.pg_class frel ON frel.oid = con.confrelid
          LEFT JOIN pg_catalog.pg_namespace fnsp ON fnsp.oid = frel.relnamespace
          LEFT JOIN pg_catalog.pg_attribute fatt ON fatt.attnum = ANY (con.confkey)
            AND fatt.attrelid = con.confrelid
          WHERE con.contype = 'f'
            AND nsp.nspname = ${schemaName}
            AND rel.relname = ${tableName}`
    );
    return result.rows;
  }

  /**
   * Get primary keys for a table
   */
  private async getPrimaryKeys(schemaName: string, tableName: string): Promise<any[]> {
    const result = await this.db.execute(
      sql`SELECT 
            con.conname AS name,
            ARRAY(
              SELECT a.attname
              FROM pg_attribute a
              WHERE a.attrelid = con.conrelid
                AND a.attnum = ANY(con.conkey)
              ORDER BY a.attnum
            ) AS columns
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace nsp ON nsp.oid = con.connamespace
          WHERE con.contype = 'p'
            AND nsp.nspname = ${schemaName}
            AND rel.relname = ${tableName}`
    );
    return result.rows;
  }

  /**
   * Get unique constraints for a table
   */
  private async getUniqueConstraints(schemaName: string, tableName: string): Promise<any[]> {
    const result = await this.db.execute(
      sql`SELECT 
            con.conname AS name,
            ARRAY(
              SELECT a.attname
              FROM pg_attribute a
              WHERE a.attrelid = con.conrelid
                AND a.attnum = ANY(con.conkey)
              ORDER BY a.attnum
            ) AS columns
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace nsp ON nsp.oid = con.connamespace
          WHERE con.contype = 'u'
            AND nsp.nspname = ${schemaName}
            AND rel.relname = ${tableName}`
    );
    return result.rows;
  }

  /**
   * Get check constraints for a table
   */
  private async getCheckConstraints(schemaName: string, tableName: string): Promise<any[]> {
    const result = await this.db.execute(
      sql`SELECT 
            con.conname AS name,
            pg_get_constraintdef(con.oid) AS definition
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace nsp ON nsp.oid = con.connamespace
          WHERE con.contype = 'c'
            AND nsp.nspname = ${schemaName}
            AND rel.relname = ${tableName}`
    );
    return result.rows;
  }

  /**
   * Get enums in a schema
   */
  private async getEnums(schemaName: string): Promise<any[]> {
    const result = await this.db.execute(
      sql`SELECT 
            n.nspname AS schema,
            t.typname AS name,
            e.enumlabel AS value,
            e.enumsortorder AS sort_order
          FROM pg_type t
          JOIN pg_enum e ON t.oid = e.enumtypid
          JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
          WHERE n.nspname = ${schemaName}
          ORDER BY schema, name, sort_order`
    );
    return result.rows;
  }

  /**
   * Parse default value for a column
   */
  private parseDefault(defaultValue: string, dataType: string): string | undefined {
    if (!defaultValue) return undefined;

    // Remove the type cast if present (e.g., "'value'::text" -> "'value'")
    const match = defaultValue.match(/^'(.*)'::/);
    if (match) {
      return `'${match[1]}'`;
    }

    // Handle nextval for sequences
    if (defaultValue.includes('nextval(')) {
      return undefined; // Serial types handle this automatically
    }

    // Handle boolean defaults
    if (dataType === 'boolean') {
      if (defaultValue === 'true') return 'true';
      if (defaultValue === 'false') return 'false';
    }

    // Return as-is for other cases
    return defaultValue;
  }

  /**
   * Check if tables exist for a plugin by checking if any tables exist in its schema
   * @param pluginName - Name of the plugin
   * @returns True if tables exist, false otherwise
   */
  async hasExistingTables(pluginName: string): Promise<boolean> {
    const schemaName =
      pluginName === '@elizaos/plugin-sql' ? 'public' : this.deriveSchemaName(pluginName);

    const result = await this.db.execute(
      sql`SELECT COUNT(*) AS count
          FROM information_schema.tables
          WHERE table_schema = ${schemaName}
            AND table_type = 'BASE TABLE'`
    );

    const count = parseInt((result.rows[0]?.count as string) || '0', 10);
    return count > 0;
  }

  /**
   * Derive schema name from plugin name
   */
  private deriveSchemaName(pluginName: string): string {
    // Same logic as in schema-transformer.ts
    return pluginName.replace('@', '').replace('/', '_').replace(/-/g, '_').toLowerCase();
  }
}
