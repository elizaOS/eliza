import { logger, type IDatabaseAdapter } from '@elizaos/core';
import { sql } from 'drizzle-orm';

/**
 * TEMPORARY MIGRATION: develop → feat/entity-rls migration
 *
 * This migration runs automatically on startup and is idempotent.
 * It handles the migration from Owner RLS to Server RLS + Entity RLS, including:
 * - Disabling old RLS policies temporarily
 * - Renaming server_id → message_server_id in channels, worlds, rooms
 * - Converting TEXT → UUID where needed
 * - Dropping old server_id columns for RLS
 * - Cleaning up indexes
 *
 * @param adapter - Database adapter
 */
export async function migrateToEntityRLS(adapter: IDatabaseAdapter): Promise<void> {
  const db = adapter.db;

  // Detect database type - skip PostgreSQL-specific migrations for SQLite
  try {
    await db.execute(sql`SELECT 1 FROM pg_tables LIMIT 1`);
  } catch {
    // Not PostgreSQL (likely SQLite)
    logger.debug('[Migration] ⊘ Not PostgreSQL, skipping PostgreSQL-specific migrations');
    return;
  }

  logger.info('[Migration] Starting develop → feat/entity-rls migration...');

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

    // Special handling for tables where server_id needs to become message_server_id
    // In develop: server_id (text or uuid) → referenced message server ID
    // In feat/entity-rls: message_server_id (uuid) → message_servers.id
    //
    // STRATEGY: Rename server_id to message_server_id preserving data
    logger.debug('[Migration] → Handling server_id → message_server_id migrations...');

    const tablesToMigrate = ['channels', 'worlds', 'rooms'];

    for (const tableName of tablesToMigrate) {
      try {
        const columnsResult = await db.execute(sql`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ${tableName}
            AND column_name IN ('server_id', 'message_server_id')
          ORDER BY column_name
        `);

        const columns = columnsResult.rows || [];
        const serverId = columns.find((c: any) => c.column_name === 'server_id');
        const messageServerId = columns.find((c: any) => c.column_name === 'message_server_id');

        if (serverId && !messageServerId) {
          // Only server_id exists → rename it to message_server_id
          logger.debug(`[Migration] → Renaming ${tableName}.server_id to message_server_id...`);
          await db.execute(sql.raw(`ALTER TABLE "${tableName}" RENAME COLUMN "server_id" TO "message_server_id"`));
          logger.debug(`[Migration] ✓ Renamed ${tableName}.server_id → message_server_id`);

          // If the column was text, try to convert to UUID (if data is UUID-compatible)
          if (serverId.data_type === 'text') {
            try {
              // CRITICAL: Drop DEFAULT constraint before type conversion
              // This prevents "default for column cannot be cast automatically" errors
              logger.debug(`[Migration] → Dropping DEFAULT constraint on ${tableName}.message_server_id...`);
              await db.execute(sql.raw(`ALTER TABLE "${tableName}" ALTER COLUMN "message_server_id" DROP DEFAULT`));
              logger.debug(`[Migration] ✓ Dropped DEFAULT constraint`);

              logger.debug(`[Migration] → Converting ${tableName}.message_server_id from text to uuid...`);
              await db.execute(sql.raw(`ALTER TABLE "${tableName}" ALTER COLUMN "message_server_id" TYPE uuid USING "message_server_id"::uuid`));
              logger.debug(`[Migration] ✓ Converted ${tableName}.message_server_id to uuid`);
            } catch (convertError) {
              logger.warn(`[Migration] ⚠️ Could not convert ${tableName}.message_server_id to uuid - data may not be valid UUIDs`);
              // If conversion fails, set to NULL for rows with invalid UUIDs
              // This allows the migration to continue
              logger.debug(`[Migration] → Setting invalid UUIDs to NULL in ${tableName}.message_server_id...`);
              await db.execute(sql.raw(`ALTER TABLE "${tableName}" ALTER COLUMN "message_server_id" TYPE uuid USING CASE WHEN "message_server_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN "message_server_id"::uuid ELSE NULL END`));
            }
          }

          // If the column should be NOT NULL but has NULLs, we need to handle that
          // For channels, it's NOT NULL in the new schema
          if (tableName === 'channels') {
            const nullCountResult = await db.execute(sql.raw(`SELECT COUNT(*) as count FROM "${tableName}" WHERE "message_server_id" IS NULL`));
            const nullCount = nullCountResult.rows?.[0]?.count;
            if (nullCount && parseInt(nullCount) > 0) {
              logger.warn(`[Migration] ⚠️ ${tableName} has ${nullCount} rows with NULL message_server_id - these will be deleted`);
              await db.execute(sql.raw(`DELETE FROM "${tableName}" WHERE "message_server_id" IS NULL`));
              logger.debug(`[Migration] ✓ Deleted ${nullCount} rows with NULL message_server_id from ${tableName}`);
            }

            // Make it NOT NULL
            logger.debug(`[Migration] → Making ${tableName}.message_server_id NOT NULL...`);
            await db.execute(sql.raw(`ALTER TABLE "${tableName}" ALTER COLUMN "message_server_id" SET NOT NULL`));
            logger.debug(`[Migration] ✓ Set ${tableName}.message_server_id NOT NULL`);
          }
        } else if (serverId && messageServerId) {
          // Both exist → just drop server_id (will be re-added by RuntimeMigrator for RLS)
          logger.debug(`[Migration] → ${tableName} has both columns, dropping server_id...`);
          await db.execute(sql.raw(`ALTER TABLE "${tableName}" DROP COLUMN "server_id" CASCADE`));
          logger.debug(`[Migration] ✓ Dropped ${tableName}.server_id (will be re-added by RuntimeMigrator for RLS)`);
        } else if (!serverId && messageServerId) {
          // Only message_server_id exists - check if it needs type conversion from TEXT to UUID
          // This handles idempotency when migration partially ran before rollback
          if (messageServerId.data_type === 'text') {
            logger.debug(`[Migration] → ${tableName}.message_server_id exists but is TEXT, needs UUID conversion...`);

            // CRITICAL: Drop DEFAULT constraint before type conversion
            // This prevents "default for column cannot be cast automatically" errors
            logger.debug(`[Migration] → Dropping DEFAULT constraint on ${tableName}.message_server_id...`);
            await db.execute(sql.raw(`ALTER TABLE "${tableName}" ALTER COLUMN "message_server_id" DROP DEFAULT`));
            logger.debug(`[Migration] ✓ Dropped DEFAULT constraint`);

            // Convert TEXT to UUID using MD5 hash for non-UUID text values
            // This creates deterministic UUIDs from text values, preserving data
            logger.debug(`[Migration] → Converting ${tableName}.message_server_id from text to uuid (generating UUIDs from text)...`);
            await db.execute(sql.raw(`
              ALTER TABLE "${tableName}"
              ALTER COLUMN "message_server_id" TYPE uuid
              USING CASE
                WHEN "message_server_id" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN "message_server_id"::uuid
                ELSE md5("message_server_id")::uuid
              END
            `));
            logger.debug(`[Migration] ✓ Converted ${tableName}.message_server_id to uuid`);
          } else {
            logger.debug(`[Migration] ⊘ ${tableName}.message_server_id already UUID, skipping`);
          }
        } else {
          logger.debug(`[Migration] ⊘ ${tableName} already migrated, skipping`);
        }
      } catch (error) {
        logger.warn(`[Migration] ⚠️ Error migrating ${tableName}.server_id: ${error}`);
      }
    }

    // Drop ALL remaining server_id columns (will be re-added by RLS after migrations)
    // This prevents RuntimeMigrator from seeing them and trying to drop them
    // EXCEPT for tables where server_id is part of the schema (like agents, server_agents)
    logger.debug('[Migration] → Dropping all remaining RLS-managed server_id columns...');
    try {
      const serverIdColumnsResult = await db.execute(sql`
        SELECT table_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'server_id'
          AND table_name NOT IN (
            'servers',              -- server_id is the primary key
            'agents',               -- server_id is in the schema (for RLS)
            'channels',             -- already handled above
            'worlds',               -- already handled above
            'rooms',                -- already handled above
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

    // Special handling for server_agents → message_server_agents rename
    // This aligns with the server_id → message_server_id naming convention
    logger.debug('[Migration] → Checking server_agents table rename...');
    try {
      const tablesResult = await db.execute(sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('server_agents', 'message_server_agents')
        ORDER BY table_name
      `);

      const tables = tablesResult.rows || [];
      const hasServerAgents = tables.some((t: any) => t.table_name === 'server_agents');
      const hasMessageServerAgents = tables.some((t: any) => t.table_name === 'message_server_agents');

      if (hasServerAgents && !hasMessageServerAgents) {
        // Rename server_agents → message_server_agents
        logger.debug('[Migration] → Renaming server_agents to message_server_agents...');
        await db.execute(sql.raw(`ALTER TABLE "server_agents" RENAME TO "message_server_agents"`));
        logger.debug('[Migration] ✓ Renamed server_agents → message_server_agents');

        // Now rename server_id column → message_server_id
        logger.debug('[Migration] → Renaming message_server_agents.server_id to message_server_id...');
        await db.execute(sql.raw(`ALTER TABLE "message_server_agents" RENAME COLUMN "server_id" TO "message_server_id"`));
        logger.debug('[Migration] ✓ Renamed message_server_agents.server_id → message_server_id');
      } else if (!hasServerAgents && !hasMessageServerAgents) {
        // Neither table exists - RuntimeMigrator will create message_server_agents
        logger.debug('[Migration] ⊘ No server_agents table to migrate');
      } else if (hasMessageServerAgents) {
        // Check if it has the columns and rename if needed
        logger.debug('[Migration] → Checking message_server_agents columns...');
        const columnsResult = await db.execute(sql`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'message_server_agents'
            AND column_name IN ('server_id', 'message_server_id')
          ORDER BY column_name
        `);

        const columns = columnsResult.rows || [];
        const hasServerId = columns.some((c: any) => c.column_name === 'server_id');
        const hasMessageServerId = columns.some((c: any) => c.column_name === 'message_server_id');

        if (hasServerId && !hasMessageServerId) {
          // Rename server_id → message_server_id
          logger.debug('[Migration] → Renaming message_server_agents.server_id to message_server_id...');
          await db.execute(sql.raw(`ALTER TABLE "message_server_agents" RENAME COLUMN "server_id" TO "message_server_id"`));
          logger.debug('[Migration] ✓ Renamed message_server_agents.server_id → message_server_id');
        } else if (!hasServerId && !hasMessageServerId) {
          // Table exists but doesn't have either column - truncate it
          logger.debug('[Migration] → message_server_agents exists without required columns, truncating...');
          await db.execute(sql`TRUNCATE TABLE message_server_agents CASCADE`);
          logger.debug('[Migration] ✓ Truncated message_server_agents');
        } else {
          logger.debug('[Migration] ⊘ message_server_agents already has correct schema');
        }
      }
    } catch (error) {
      logger.debug('[Migration] ⊘ Could not check/migrate server_agents table');
    }

    // Special handling for channel_participants: rename userId → entityId
    // This handles the migration from the old userId column to the new entityId column
    logger.debug('[Migration] → Checking channel_participants table...');
    try {
      const columnsResult = await db.execute(sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'channel_participants'
          AND column_name IN ('user_id', 'entity_id')
        ORDER BY column_name
      `);

      const columns = columnsResult.rows || [];
      const hasUserId = columns.some((c: any) => c.column_name === 'user_id');
      const hasEntityId = columns.some((c: any) => c.column_name === 'entity_id');

      if (hasUserId && !hasEntityId) {
        // Rename user_id → entity_id
        logger.debug('[Migration] → Renaming channel_participants.user_id to entity_id...');
        await db.execute(sql.raw(`ALTER TABLE "channel_participants" RENAME COLUMN "user_id" TO "entity_id"`));
        logger.debug('[Migration] ✓ Renamed channel_participants.user_id → entity_id');
      } else if (!hasUserId && !hasEntityId) {
        // Table exists but has neither column - truncate it so RuntimeMigrator can add entity_id
        logger.debug('[Migration] → channel_participants exists without entity_id or user_id, truncating...');
        await db.execute(sql`TRUNCATE TABLE channel_participants CASCADE`);
        logger.debug('[Migration] ✓ Truncated channel_participants');
      } else {
        logger.debug('[Migration] ⊘ channel_participants already has entity_id column');
      }
    } catch (error) {
      logger.debug('[Migration] ⊘ Could not check/migrate channel_participants');
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

    logger.info('[Migration] ✓ Migration complete - develop to feat/entity-rls migration finished');
  } catch (error) {
    // Re-throw errors to prevent RuntimeMigrator from running on broken state
    logger.error('[Migration] Migration failed:', String(error));
    throw error;
  }
}