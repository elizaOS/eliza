import { logger, type IDatabaseAdapter } from '@elizaos/core';
import { sql } from 'drizzle-orm';

/**
 * TEMPORARY MIGRATION: Rename all camelCase columns to snake_case automatically
 *
 * This migration runs automatically on startup and is idempotent.
 * It can be safely removed after a few weeks/months when all users have migrated.
 *
 * Background: We're migrating to PostgreSQL snake_case convention using
 * Drizzle's `casing: 'snake_case'` option. This migration automatically detects
 * and renames ALL camelCase columns to snake_case across ALL tables.
 *
 * @param adapter - Database adapter
 */
export async function migrateColumnsToSnakeCase(adapter: IDatabaseAdapter): Promise<void> {
  const db = adapter.db;

  logger.info('[Migration] Checking if camelCase → snake_case migration is needed...');

  try {
    // ALWAYS clear RuntimeMigrator snapshot cache to force fresh introspection
    // This ensures the snapshot matches the current database state after our migrations
    logger.debug('[Migration] → Clearing RuntimeMigrator snapshot cache...');
    try {
      await db.execute(sql`DELETE FROM migrations._snapshots WHERE plugin_name = '@elizaos/plugin-sql'`);
      logger.debug('[Migration] ✓ Snapshot cache cleared');
    } catch (error) {
      // If migrations schema doesn't exist yet, that's fine - no cache to clear
      logger.debug('[Migration] ⊘ No snapshot cache to clear (migrations schema not yet created)');
    }

    // Disable RLS on all tables temporarily
    // RLS will be re-implemented properly later
    logger.debug('[Migration] → Disabling Row Level Security on all tables...');
    try {
      const tablesResult = await db.execute(sql`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      `);

      for (const row of tablesResult.rows || []) {
        const tableName = row.tablename as string;
        try {
          await db.execute(sql.raw(`ALTER TABLE "${tableName}" DISABLE ROW LEVEL SECURITY`));
          logger.debug(`[Migration] ✓ Disabled RLS on ${tableName}`);
        } catch (error) {
          // Table might not have RLS enabled, that's fine
          logger.debug(`[Migration] ⊘ Could not disable RLS on ${tableName}`);
        }
      }
    } catch (error) {
      logger.debug('[Migration] ⊘ Could not disable RLS (may not have permissions)');
    }

    // Drop ALL server_id columns (will be re-added by RLS after migrations)
    // This prevents RuntimeMigrator from seeing them and trying to drop them
    // EXCEPT for tables where server_id is part of the schema (like agents, channels, server_agents)
    logger.debug('[Migration] → Dropping all RLS-managed server_id columns...');
    try {
      const serverIdColumnsResult = await db.execute(sql`
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'server_id'
          AND table_name NOT IN (
            'servers',              -- server_id is the primary key
            'agents',               -- server_id is in the schema
            'channels',             -- server_id is in the schema
            'server_agents',        -- server_id is part of composite key
            'drizzle_migrations',
            '__drizzle_migrations'
          )
        ORDER BY table_name
      `);

      const tablesToClean = serverIdColumnsResult.rows || [];
      logger.debug(`[Migration] → Found ${tablesToClean.length} tables with server_id columns`);

      for (const row of tablesToClean) {
        const tableName = row.table_name as string;
        try {
          await db.execute(sql.raw(`ALTER TABLE "${tableName}" DROP COLUMN IF EXISTS server_id CASCADE`));
          logger.debug(`[Migration] ✓ Dropped server_id from ${tableName}`);
        } catch (error) {
          logger.debug(`[Migration] ⊘ Could not drop server_id from ${tableName}`);
        }
      }
    } catch (error) {
      logger.debug('[Migration] ⊘ Could not drop server_id columns (may not have permissions)');
    }

    // Special handling for server_agents table: if it exists but doesn't have server_id column,
    // truncate it so RuntimeMigrator can add the NOT NULL column
    logger.debug('[Migration] → Checking server_agents table...');
    try {
      const serverAgentsHasServerId = await db.execute(sql`
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'server_agents'
            AND column_name = 'server_id'
        ) as has_column
      `);

      const hasColumn = serverAgentsHasServerId.rows?.[0]?.has_column;

      if (!hasColumn) {
        // Table exists but doesn't have server_id - truncate it
        logger.debug('[Migration] → server_agents exists without server_id, truncating...');
        await db.execute(sql`TRUNCATE TABLE server_agents CASCADE`);
        logger.debug('[Migration] ✓ Truncated server_agents');
      }
    } catch (error) {
      logger.debug('[Migration] ⊘ Could not check/truncate server_agents');
    }

    // Drop ALL regular indexes (not PK or unique constraints) to avoid conflicts
    // The RuntimeMigrator will recreate them based on the schema
    logger.debug('[Migration] → Discovering and dropping all regular indexes...');
    try {
      const indexesResult = await db.execute(sql`
        SELECT i.relname AS index_name
        FROM pg_index idx
        JOIN pg_class i ON i.oid = idx.indexrelid
        JOIN pg_class c ON c.oid = idx.indrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_constraint con ON con.conindid = idx.indexrelid
        WHERE n.nspname = 'public'
          AND NOT idx.indisprimary  -- Not a primary key
          AND con.contype IS NULL   -- Not a constraint (unique, etc)
        ORDER BY i.relname
      `);

      const indexesToDrop = indexesResult.rows || [];
      logger.debug(`[Migration] → Found ${indexesToDrop.length} indexes to drop`);

      for (const row of indexesToDrop) {
        const indexName = row.index_name as string;
        try {
          await db.execute(sql.raw(`DROP INDEX IF EXISTS "${indexName}"`));
          logger.debug(`[Migration] ✓ Dropped index ${indexName}`);
        } catch (error) {
          logger.debug(`[Migration] ⊘ Could not drop index ${indexName}`);
        }
      }
    } catch (error) {
      logger.debug('[Migration] ⊘ Could not drop indexes (may not have permissions)');
    }

    // Get ALL camelCase columns that need migration
    const columnsResult = await db.execute(sql`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name ~ '[A-Z]'  -- Contains uppercase = camelCase
        AND table_name NOT IN ('drizzle_migrations', '__drizzle_migrations')
      ORDER BY table_name, column_name
    `);

    const columns = columnsResult.rows || [];

    if (columns.length === 0) {
      logger.info('[Migration] ✓ All columns already in snake_case, skipping migration');
      return;
    }

    logger.info(`[Migration] → Found ${columns.length} camelCase columns to migrate...`);

    // Rename each column individually with proper error handling
    let successCount = 0;
    let errorCount = 0;

    for (const col of columns) {
      const tableName = col.table_name as string;
      const columnName = col.column_name as string;

      // Convert camelCase to snake_case
      // Example: entityId -> entity_id, createdAt -> created_at
      let snakeCaseName = columnName.replace(/([A-Z])/g, '_$1').toLowerCase();
      snakeCaseName = snakeCaseName.replace(/^_/, ''); // Remove leading underscore

      try {
        // Check if the snake_case column already exists
        const checkResult = await db.execute(sql`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ${tableName}
            AND column_name = ${snakeCaseName}
        `);

        if (checkResult.rows && checkResult.rows.length > 0) {
          // snake_case column already exists - check if we can merge or just drop
          logger.debug(
            `[Migration] → Column ${snakeCaseName} already exists, checking data types...`
          );

          // Get data types of both columns
          const typeResult = await db.execute(sql`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = ${tableName}
              AND column_name IN (${columnName}, ${snakeCaseName})
          `);

          const camelType = typeResult.rows?.find((r) => r.column_name === columnName)?.data_type;
          const snakeType = typeResult.rows?.find((r) => r.column_name === snakeCaseName)?.data_type;

          if (camelType === snakeType) {
            // Same type - safe to merge
            logger.debug(`[Migration] → Merging ${tableName}.${columnName} into ${snakeCaseName}...`);

            await db.execute(
              sql.raw(
                `UPDATE "${tableName}" SET "${snakeCaseName}" = COALESCE("${snakeCaseName}", "${columnName}")`
              )
            );

            await db.execute(sql.raw(`ALTER TABLE "${tableName}" DROP COLUMN "${columnName}"`));

            logger.debug(`[Migration] ✓ Merged and dropped ${tableName}.${columnName}`);
            successCount++;
          } else {
            // Different types - just drop the camelCase column (snake_case is the new source of truth)
            logger.debug(
              `[Migration] → Type mismatch (${camelType} vs ${snakeType}), dropping old ${tableName}.${columnName}...`
            );

            await db.execute(sql.raw(`ALTER TABLE "${tableName}" DROP COLUMN "${columnName}"`));

            logger.debug(`[Migration] ✓ Dropped ${tableName}.${columnName}`);
            successCount++;
          }
        } else {
          // Normal rename
          await db.execute(
            sql.raw(`ALTER TABLE "${tableName}" RENAME COLUMN "${columnName}" TO "${snakeCaseName}"`)
          );
          logger.debug(`[Migration] ✓ Renamed ${tableName}.${columnName} → ${snakeCaseName}`);
          successCount++;
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check if column already exists (already migrated)
        if (
          errorMessage.includes('already exists') ||
          errorMessage.includes('does not exist')
        ) {
          logger.debug(
            `[Migration] ⊘ Skipped ${tableName}.${columnName} (already migrated or doesn't exist)`
          );
        } else {
          // Unexpected error
          logger.error(
            `[Migration] ✗ Failed to rename ${tableName}.${columnName}: ${errorMessage}`
          );
          errorCount++;
        }
      }
    }

    logger.success(
      `[Migration] ✓ Migration complete: ${successCount} renamed, ${errorCount} errors`
    );

    // If we had errors, throw to prevent RuntimeMigrator from running
    if (errorCount > 0) {
      throw new Error(`Migration completed with ${errorCount} errors`);
    }

    // IMPORTANT: Clear the RuntimeMigrator's snapshot cache
    // The old snapshot has camelCase column names, which no longer match the DB
    // Force RuntimeMigrator to regenerate the snapshot from the current DB state
    if (successCount > 0) {
      logger.info('[Migration] → Clearing RuntimeMigrator snapshot cache...');
      try {
        await db.execute(sql`DELETE FROM migrations._snapshots WHERE plugin_name = '@elizaos/plugin-sql'`);
        logger.debug('[Migration] ✓ Snapshot cache cleared');
      } catch (error) {
        // If migrations schema doesn't exist yet, that's fine - no cache to clear
        logger.debug('[Migration] ⊘ No snapshot cache to clear (migrations schema not yet created)');
      }
    }
  } catch (error) {
    // Re-throw errors to prevent RuntimeMigrator from running on broken state
    logger.error('[Migration] Migration failed:', String(error));
    throw error;
  }
}