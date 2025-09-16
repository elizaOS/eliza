import { sql } from 'drizzle-orm';
import { logger } from '@elizaos/core';
import type { DrizzleDB, TableDefinition } from './types';
import { extractErrorDetails, topologicalSort } from './utils';
import { DrizzleSchemaIntrospector, PluginNamespaceManager, ExtensionManager } from './classes';

export async function runPluginMigrations(
  db: DrizzleDB,
  pluginName: string,
  schema: any
): Promise<void> {
  logger.debug(`[CUSTOM MIGRATOR] Starting migration for plugin: ${pluginName}`);

  // Test database connection first
  try {
    await db.execute(sql.raw('SELECT 1'));
    logger.debug('[CUSTOM MIGRATOR] Database connection verified');
  } catch (error) {
    const errorDetails = extractErrorDetails(error);
    logger.error(`[CUSTOM MIGRATOR] Database connection failed: ${errorDetails.message}`);
    if (errorDetails.stack) {
      logger.error(`[CUSTOM MIGRATOR] Stack trace: ${errorDetails.stack}`);
    }
    throw new Error(`Database connection failed: ${errorDetails.message}`);
  }

  const namespaceManager = new PluginNamespaceManager(db);
  const introspector = new DrizzleSchemaIntrospector();
  const extensionManager = new ExtensionManager(db);

  await extensionManager.installRequiredExtensions(['vector', 'fuzzystrmatch']);
  const schemaName = await namespaceManager.getPluginSchema(pluginName);
  await namespaceManager.ensureNamespace(schemaName);
  const existingTables = await namespaceManager.introspectExistingTables(schemaName);

  // Discover all tables
  const tableEntries = Object.entries(schema).filter(([key, v]) => {
    const isDrizzleTable =
      v &&
      (((v as any)._ && typeof (v as any)._.name === 'string') ||
        (typeof v === 'object' &&
          v !== null &&
          ('tableName' in v || 'dbName' in v || key.toLowerCase().includes('table'))));
    return isDrizzleTable;
  });

  // Parse all table definitions
  const tableDefinitions = new Map<string, TableDefinition>();
  for (const [exportKey, table] of tableEntries) {
    const tableDef = introspector.parseTableDefinition(table, exportKey);
    tableDefinitions.set(tableDef.name, tableDef);
  }

  // Sort tables by dependencies (topological sort)
  const sortedTableNames = topologicalSort(tableDefinitions);

  try {
    // Phase 1: Create all tables without foreign key constraints
    logger.debug(`[CUSTOM MIGRATOR] Phase 1: Creating tables...`);
    for (const tableName of sortedTableNames) {
      const tableDef = tableDefinitions.get(tableName);
      if (!tableDef) continue;

      const tableExists = existingTables.includes(tableDef.name);
      logger.debug(`[CUSTOM MIGRATOR] Table ${tableDef.name} exists: ${tableExists}`);

      if (!tableExists) {
        logger.debug(`[CUSTOM MIGRATOR] Creating table: ${tableDef.name}`);
        try {
          await namespaceManager.createTable(tableDef, schemaName);
        } catch (error) {
          const errorDetails = extractErrorDetails(error);
          logger.error(
            `[CUSTOM MIGRATOR] Failed to create table ${tableDef.name}: ${errorDetails.message}`
          );
          if (errorDetails.stack) {
            logger.error(`[CUSTOM MIGRATOR] Table creation stack trace: ${errorDetails.stack}`);
          }
          throw new Error(`Failed to create table ${tableDef.name}: ${errorDetails.message}`);
        }
      } else {
        logger.debug(`[CUSTOM MIGRATOR] Table ${tableDef.name} already exists, skipping creation`);
      }
    }

    // Phase 2: Add constraints (foreign keys, check constraints, etc.)
    logger.debug(`[CUSTOM MIGRATOR] Phase 2: Adding constraints...`);
    for (const tableName of sortedTableNames) {
      const tableDef = tableDefinitions.get(tableName);
      if (!tableDef) continue;

      // Add constraints if table has foreign keys OR check constraints
      if (tableDef.foreignKeys.length > 0 || tableDef.checkConstraints.length > 0) {
        logger.debug(
          `[CUSTOM MIGRATOR] Adding constraints for table: ${tableDef.name} - ${JSON.stringify({
            foreignKeys: tableDef.foreignKeys.length,
            checkConstraints: tableDef.checkConstraints.length,
          })}`
        );
        await namespaceManager.addConstraints(tableDef, schemaName);
      }
    }

    logger.debug(`[CUSTOM MIGRATOR] Completed migration for plugin: ${pluginName}`);
  } catch (error) {
    const errorDetails = extractErrorDetails(error);
    logger.error(
      `[CUSTOM MIGRATOR] Migration failed for plugin ${pluginName}: ${errorDetails.message}`
    );
    if (errorDetails.stack) {
      logger.error(`[CUSTOM MIGRATOR] Migration stack trace: ${errorDetails.stack}`);
    }
    throw new Error(`Migration failed for plugin ${pluginName}: ${errorDetails.message}`);
  }
}
