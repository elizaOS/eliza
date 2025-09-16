import { sql } from 'drizzle-orm';
import { logger } from '@elizaos/core';
import type { DrizzleDB, TableDefinition } from '../types';
import { extractErrorMessage } from '../utils';
import { DrizzleSchemaIntrospector } from './schema-introspector';

export class PluginNamespaceManager {
  constructor(private db: DrizzleDB) {}

  async getPluginSchema(pluginName: string): Promise<string> {
    if (pluginName === '@elizaos/plugin-sql') {
      // For the core SQL plugin, try to use the current schema if available (for PG)
      // Otherwise, default to public.
      try {
        const result = await this.db.execute(sql.raw('SHOW search_path'));
        if (result.rows && result.rows.length > 0) {
          const searchPath = (result.rows[0] as any).search_path;
          // The search_path can be a comma-separated list, iterate to find the first valid schema
          const schemas = searchPath.split(',').map((s: string) => s.trim());
          for (const schema of schemas) {
            if (schema && !schema.includes('$user')) {
              return schema;
            }
          }
        }
      } catch (e) {
        // This query might fail on PGLite if not supported, fallback to public
        logger.debug('Could not determine search_path, defaulting to public schema.');
      }
      return 'public';
    }
    return pluginName.replace(/@elizaos\/plugin-|\W/g, '_').toLowerCase();
  }

  async ensureNamespace(schemaName: string): Promise<void> {
    if (schemaName === 'public') return;
    await this.db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`));
  }

  async introspectExistingTables(schemaName: string): Promise<string[]> {
    const res = await this.db.execute(
      sql.raw(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schemaName}'`
      )
    );
    return (res.rows as any[]).map((row) => row.table_name);
  }

  async foreignKeyExists(
    schemaName: string,
    tableName: string,
    constraintName: string
  ): Promise<boolean> {
    try {
      const res = await this.db.execute(
        sql.raw(
          `SELECT constraint_name 
           FROM information_schema.table_constraints 
           WHERE table_schema = '${schemaName}' 
           AND table_name = '${tableName}' 
           AND constraint_name = '${constraintName}' 
           AND constraint_type = 'FOREIGN KEY'`
        )
      );
      return res.rows.length > 0;
    } catch (error) {
      // If the query fails, assume the constraint doesn't exist
      return false;
    }
  }

  async checkConstraintExists(
    schemaName: string,
    tableName: string,
    constraintName: string
  ): Promise<boolean> {
    try {
      const res = await this.db.execute(
        sql.raw(
          `SELECT constraint_name 
           FROM information_schema.table_constraints 
           WHERE table_schema = '${schemaName}' 
           AND table_name = '${tableName}' 
           AND constraint_name = '${constraintName}' 
           AND constraint_type = 'CHECK'`
        )
      );
      return res.rows.length > 0;
    } catch (error) {
      // If the query fails, assume the constraint doesn't exist
      return false;
    }
  }

  async uniqueConstraintExists(
    schemaName: string,
    tableName: string,
    constraintName: string
  ): Promise<boolean> {
    try {
      const res = await this.db.execute(
        sql.raw(
          `SELECT constraint_name 
           FROM information_schema.table_constraints 
           WHERE table_schema = '${schemaName}' 
           AND table_name = '${tableName}' 
           AND constraint_name = '${constraintName}' 
           AND constraint_type = 'UNIQUE'`
        )
      );
      return res.rows.length > 0;
    } catch (error) {
      // If the query fails, assume the constraint doesn't exist
      return false;
    }
  }

  async createTable(tableDef: TableDefinition, schemaName: string): Promise<void> {
    const introspector = new DrizzleSchemaIntrospector();
    const createTableSQL = introspector.generateCreateTableSQL(tableDef, schemaName);

    await this.db.execute(sql.raw(createTableSQL));
    logger.info(`Created table: ${tableDef.name}`);
  }

  async addConstraints(tableDef: TableDefinition, schemaName: string): Promise<void> {
    // Add foreign key constraints
    if (tableDef.foreignKeys.length > 0) {
      const introspector = new DrizzleSchemaIntrospector();
      const constraintSQLs = introspector.generateForeignKeySQL(tableDef, schemaName);
      for (let i = 0; i < tableDef.foreignKeys.length; i++) {
        const fk = tableDef.foreignKeys[i];
        const constraintSQL = constraintSQLs[i];

        try {
          // Check if foreign key already exists
          const exists = await this.foreignKeyExists(schemaName, tableDef.name, fk.name);
          if (exists) {
            logger.debug(
              `[CUSTOM MIGRATOR] Foreign key constraint ${fk.name} already exists, skipping`
            );
            continue;
          }

          await this.db.execute(sql.raw(constraintSQL));
          logger.debug(`[CUSTOM MIGRATOR] Successfully added foreign key constraint: ${fk.name}`);
        } catch (error: any) {
          // Log the error but continue processing other constraints
          const errorMessage = extractErrorMessage(error);
          if (errorMessage.includes('already exists')) {
            logger.debug(`[CUSTOM MIGRATOR] Foreign key constraint already exists: ${fk.name}`);
          } else {
            logger.warn(
              `[CUSTOM MIGRATOR] Could not add foreign key constraint (may already exist): ${errorMessage}`
            );
          }
        }
      }
    }

    // Add check constraints
    if (tableDef.checkConstraints.length > 0) {
      for (const checkConstraint of tableDef.checkConstraints) {
        try {
          // Check if check constraint already exists
          const exists = await this.checkConstraintExists(
            schemaName,
            tableDef.name,
            checkConstraint.name
          );
          if (exists) {
            logger.debug(
              `[CUSTOM MIGRATOR] Check constraint ${checkConstraint.name} already exists, skipping`
            );
            continue;
          }

          const checkSQL = `ALTER TABLE "${schemaName}"."${tableDef.name}" ADD CONSTRAINT "${checkConstraint.name}" CHECK (${checkConstraint.expression})`;
          await this.db.execute(sql.raw(checkSQL));
          logger.debug(
            `[CUSTOM MIGRATOR] Successfully added check constraint: ${checkConstraint.name}`
          );
        } catch (error: any) {
          const errorMessage = extractErrorMessage(error);
          if (errorMessage.includes('already exists')) {
            logger.debug(
              `[CUSTOM MIGRATOR] Check constraint already exists: ${checkConstraint.name}`
            );
          } else {
            logger.warn(
              `[CUSTOM MIGRATOR] Could not add check constraint ${checkConstraint.name} (may already exist): ${errorMessage}`
            );
          }
        }
      }
    }
  }
}
