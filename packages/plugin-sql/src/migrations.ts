import { logger, type IDatabaseAdapter } from '@elizaos/core';
import { sql } from 'drizzle-orm';
import { getDb } from './types';

/**
 * TEMPORARY MIGRATION: pre-1.6.5 → 1.6.5+ schema migration
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
  const db = getDb(adapter);

  // Detect database type - skip PostgreSQL-specific migrations for SQLite
  try {
    await db.execute(sql`SELECT 1 FROM pg_tables LIMIT 1`);
  } catch {
    // Not PostgreSQL (likely SQLite)
    logger.debug('[Migration] ⊘ Not PostgreSQL, skipping PostgreSQL-specific migrations');
    return;
  }

  // Check if schema migration has already been completed
  // We use the presence of snake_case columns as a marker
  let schemaAlreadyMigrated = false;
  try {
    const migrationCheck = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'rooms'
        AND column_name = 'agent_id'
    `);

    if (migrationCheck.rows && migrationCheck.rows.length > 0) {
      // Migration already completed - rooms.agent_id exists (snake_case)
      schemaAlreadyMigrated = true;
      logger.debug('[Migration] ⊘ Schema already migrated (snake_case columns exist)');
    }
  } catch {
    // Table might not exist yet, continue with migration
    logger.debug('[Migration] → rooms table not found, will be created by RuntimeMigrator');
    return; // Let RuntimeMigrator create fresh tables
  }

  // If schema is already migrated, check if we need to clean up RLS
  // Only disable RLS if ENABLE_DATA_ISOLATION is NOT true (user disabled isolation)
  // If ENABLE_DATA_ISOLATION=true, keep RLS as-is - migration-service.ts will ensure proper config
  if (schemaAlreadyMigrated) {
    const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === 'true';

    if (dataIsolationEnabled) {
      // RLS should stay enabled - no need to disable/re-enable cycle
      // Note: migration-service.ts will ensure RLS is properly configured after this
      // via applyRLSToNewTables() and applyEntityRLSToAllTables() which are idempotent
      logger.debug('[Migration] ⊘ Schema already migrated, RLS enabled - nothing to do');
      return;
    }

    // User disabled data isolation - clean up RLS if it was previously enabled
    logger.debug('[Migration] → Schema migrated but RLS disabled, cleaning up...');

    try {
      const tablesWithRls = await db.execute(sql`
        SELECT c.relname as tablename
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relrowsecurity = true
        ORDER BY c.relname
      `);

      if (tablesWithRls.rows && tablesWithRls.rows.length > 0) {
        for (const row of tablesWithRls.rows) {
          const tableName = row.tablename as string;
          try {
            await db.execute(sql.raw(`ALTER TABLE "${tableName}" DISABLE ROW LEVEL SECURITY`));
          } catch {
            // Ignore errors
          }
        }
        logger.debug(`[Migration] ✓ RLS cleanup completed (${tablesWithRls.rows.length} tables)`);
      } else {
        logger.debug('[Migration] ⊘ No tables with RLS to clean up');
      }
    } catch {
      logger.debug('[Migration] ⊘ Could not perform RLS cleanup');
    }

    return;
  }

  logger.info('[Migration] Starting pre-1.6.5 → 1.6.5+ schema migration...');

  try {
    // Clear RuntimeMigrator snapshot cache to force fresh introspection
    // This ensures the snapshot matches the current database state after our migrations
    logger.debug('[Migration] → Clearing RuntimeMigrator snapshot cache...');
    try {
      await db.execute(
        sql`DELETE FROM migrations._snapshots WHERE plugin_name = '@elizaos/plugin-sql'`
      );
      logger.debug('[Migration] ✓ Snapshot cache cleared');
    } catch (error) {
      // If migrations schema doesn't exist yet, that's fine - no cache to clear
      logger.debug('[Migration] ⊘ No snapshot cache to clear (migrations schema not yet created)');
    }

    // Disable RLS only on tables that have it enabled
    // RLS will be re-implemented properly later
    logger.debug('[Migration] → Checking for Row Level Security to disable...');
    try {
      const tablesWithRls = await db.execute(sql`
        SELECT c.relname as tablename
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relrowsecurity = true
        ORDER BY c.relname
      `);

      if (tablesWithRls.rows && tablesWithRls.rows.length > 0) {
        for (const row of tablesWithRls.rows) {
          const tableName = row.tablename as string;
          try {
            await db.execute(sql.raw(`ALTER TABLE "${tableName}" DISABLE ROW LEVEL SECURITY`));
            logger.debug(`[Migration] ✓ Disabled RLS on ${tableName}`);
          } catch (error) {
            logger.debug(`[Migration] ⊘ Could not disable RLS on ${tableName}`);
          }
        }
      } else {
        logger.debug('[Migration] ⊘ No tables with RLS enabled');
      }
    } catch (error) {
      logger.debug('[Migration] ⊘ Could not check RLS (may not have permissions)');
    }

    // Special handling for tables where serverId/server_id needs to become message_server_id
    // v1.6.4 had: rooms.serverId (TEXT camelCase), worlds.serverId (TEXT camelCase), channels.server_id (UUID)
    // Current: message_server_id (UUID) in all tables
    //
    // STRATEGY: Rename serverId/server_id to message_server_id preserving data
    logger.debug('[Migration] → Handling serverId/server_id → message_server_id migrations...');

    const tablesToMigrate = ['channels', 'worlds', 'rooms'];

    for (const tableName of tablesToMigrate) {
      try {
        // Check for both camelCase (serverId) and snake_case (server_id) columns
        const columnsResult = await db.execute(sql`
          SELECT column_name, data_type, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ${tableName}
            AND column_name IN ('server_id', 'serverId', 'message_server_id')
          ORDER BY column_name
        `);

        const columns = columnsResult.rows || [];
        const serverIdSnake = columns.find((c: any) => c.column_name === 'server_id');
        const serverIdCamel = columns.find((c: any) => c.column_name === 'serverId');
        const messageServerId = columns.find((c: any) => c.column_name === 'message_server_id');

        // Use whichever old column exists (prefer snake_case for channels)
        const serverId = serverIdSnake || serverIdCamel;
        const oldColumnName = serverIdSnake ? 'server_id' : 'serverId';

        if (serverId && !messageServerId) {
          // Old column exists → rename it to message_server_id
          logger.debug(
            `[Migration] → Renaming ${tableName}.${oldColumnName} to message_server_id...`
          );
          await db.execute(
            sql.raw(
              `ALTER TABLE "${tableName}" RENAME COLUMN "${oldColumnName}" TO "message_server_id"`
            )
          );
          logger.debug(`[Migration] ✓ Renamed ${tableName}.${oldColumnName} → message_server_id`);

          // If the column was text, try to convert to UUID (if data is UUID-compatible)
          if (serverId.data_type === 'text') {
            // CRITICAL: Drop DEFAULT constraint before type conversion
            // This prevents "default for column cannot be cast automatically" errors
            // Wrap in separate try-catch to ensure we continue even if no default exists
            try {
              logger.debug(
                `[Migration] → Dropping DEFAULT constraint on ${tableName}.message_server_id...`
              );
              await db.execute(
                sql.raw(`ALTER TABLE "${tableName}" ALTER COLUMN "message_server_id" DROP DEFAULT`)
              );
              logger.debug(`[Migration] ✓ Dropped DEFAULT constraint`);
            } catch {
              logger.debug(
                `[Migration] ⊘ No DEFAULT constraint to drop on ${tableName}.message_server_id`
              );
            }

            try {
              logger.debug(
                `[Migration] → Converting ${tableName}.message_server_id from text to uuid...`
              );
              // Use robust conversion: valid UUIDs are cast directly, others get md5 hash
              // This handles: empty strings, non-UUID text, uppercase UUIDs, NULL values
              await db.execute(
                sql.raw(`
                  ALTER TABLE "${tableName}"
                  ALTER COLUMN "message_server_id" TYPE uuid
                  USING CASE
                    WHEN "message_server_id" IS NULL THEN NULL
                    WHEN "message_server_id" = '' THEN NULL
                    WHEN "message_server_id" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                    THEN "message_server_id"::uuid
                    ELSE md5("message_server_id")::uuid
                  END
                `)
              );
              logger.debug(`[Migration] ✓ Converted ${tableName}.message_server_id to uuid`);
            } catch (convertError) {
              logger.warn(
                `[Migration] ⚠️ Could not convert ${tableName}.message_server_id to uuid: ${convertError}`
              );
            }
          }

          // If the column should be NOT NULL but has NULLs, we need to handle that
          // For channels, it's NOT NULL in the new schema
          if (tableName === 'channels') {
            const nullCountResult = await db.execute(
              sql.raw(
                `SELECT COUNT(*) as count FROM "${tableName}" WHERE "message_server_id" IS NULL`
              )
            );
            const nullCount = nullCountResult.rows?.[0]?.count as string | undefined;
            if (nullCount && parseInt(nullCount, 10) > 0) {
              logger.warn(
                `[Migration] ⚠️ ${tableName} has ${nullCount} rows with NULL message_server_id - these will be deleted`
              );
              await db.execute(
                sql.raw(`DELETE FROM "${tableName}" WHERE "message_server_id" IS NULL`)
              );
              logger.debug(
                `[Migration] ✓ Deleted ${nullCount} rows with NULL message_server_id from ${tableName}`
              );
            }

            // Make it NOT NULL
            logger.debug(`[Migration] → Making ${tableName}.message_server_id NOT NULL...`);
            await db.execute(
              sql.raw(`ALTER TABLE "${tableName}" ALTER COLUMN "message_server_id" SET NOT NULL`)
            );
            logger.debug(`[Migration] ✓ Set ${tableName}.message_server_id NOT NULL`);
          }
        } else if (serverId && messageServerId) {
          // Both exist → just drop the old column
          logger.debug(`[Migration] → ${tableName} has both columns, dropping ${oldColumnName}...`);
          await db.execute(
            sql.raw(`ALTER TABLE "${tableName}" DROP COLUMN "${oldColumnName}" CASCADE`)
          );
          logger.debug(`[Migration] ✓ Dropped ${tableName}.${oldColumnName}`);
        } else if (!serverId && messageServerId) {
          // Only message_server_id exists - check if it needs type conversion from TEXT to UUID
          // This handles idempotency when migration partially ran before rollback
          if (messageServerId.data_type === 'text') {
            logger.debug(
              `[Migration] → ${tableName}.message_server_id exists but is TEXT, needs UUID conversion...`
            );

            // CRITICAL: Drop DEFAULT constraint before type conversion
            // This prevents "default for column cannot be cast automatically" errors
            logger.debug(
              `[Migration] → Dropping DEFAULT constraint on ${tableName}.message_server_id...`
            );
            await db.execute(
              sql.raw(`ALTER TABLE "${tableName}" ALTER COLUMN "message_server_id" DROP DEFAULT`)
            );
            logger.debug(`[Migration] ✓ Dropped DEFAULT constraint`);

            // Convert TEXT to UUID using MD5 hash for non-UUID text values
            // This creates deterministic UUIDs from text values, preserving data
            logger.debug(
              `[Migration] → Converting ${tableName}.message_server_id from text to uuid (generating UUIDs from text)...`
            );
            await db.execute(
              sql.raw(`
              ALTER TABLE "${tableName}"
              ALTER COLUMN "message_server_id" TYPE uuid
              USING CASE
                WHEN "message_server_id" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                THEN "message_server_id"::uuid
                ELSE md5("message_server_id")::uuid
              END
            `)
            );
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
          await db.execute(
            sql.raw(`ALTER TABLE "${tableName}" DROP COLUMN IF EXISTS server_id CASCADE`)
          );
          logger.debug(`[Migration] ✓ Dropped server_id from ${tableName}`);
        } catch (error) {
          logger.debug(`[Migration] ⊘ Could not drop server_id from ${tableName}`);
        }
      }
    } catch (error) {
      logger.debug('[Migration] ⊘ Could not drop server_id columns (may not have permissions)');
    }

    // Special handling for agents table: rename owner_id → server_id
    // v1.6.4 had owner_id, v1.6.5 changed it to server_id
    logger.debug('[Migration] → Checking agents.owner_id → server_id rename...');
    try {
      const agentsColumnsResult = await db.execute(sql`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'agents'
          AND column_name IN ('owner_id', 'server_id')
        ORDER BY column_name
      `);

      const agentsColumns = agentsColumnsResult.rows || [];
      const hasOwnerId = agentsColumns.some((c: any) => c.column_name === 'owner_id');
      const hasServerId = agentsColumns.some((c: any) => c.column_name === 'server_id');

      if (hasOwnerId && !hasServerId) {
        // Rename owner_id → server_id
        logger.debug('[Migration] → Renaming agents.owner_id to server_id...');
        await db.execute(sql.raw(`ALTER TABLE "agents" RENAME COLUMN "owner_id" TO "server_id"`));
        logger.debug('[Migration] ✓ Renamed agents.owner_id → server_id');
      } else if (hasOwnerId && hasServerId) {
        // Both exist - drop owner_id (data should be in server_id)
        logger.debug('[Migration] → Both owner_id and server_id exist, dropping owner_id...');
        await db.execute(sql.raw(`ALTER TABLE "agents" DROP COLUMN "owner_id" CASCADE`));
        logger.debug('[Migration] ✓ Dropped agents.owner_id');
      } else {
        logger.debug('[Migration] ⊘ agents table already has server_id (or no owner_id), skipping');
      }
    } catch (error) {
      logger.debug('[Migration] ⊘ Could not check/migrate agents.owner_id');
    }

    // Migrate data from obsolete 'owners' table to 'servers' (if owners exists)
    // v1.6.4 used owners table, v1.6.5+ uses servers table
    logger.debug('[Migration] → Checking for owners → servers data migration...');
    try {
      const ownersTableResult = await db.execute(sql`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'owners'
      `);

      if (ownersTableResult.rows && ownersTableResult.rows.length > 0) {
        // First, ensure servers table exists
        logger.debug('[Migration] → Ensuring servers table exists...');
        await db.execute(
          sql.raw(`
          CREATE TABLE IF NOT EXISTS "servers" (
            "id" uuid PRIMARY KEY,
            "created_at" timestamp with time zone DEFAULT now() NOT NULL,
            "updated_at" timestamp with time zone DEFAULT now() NOT NULL
          )
        `)
        );

        // Migrate data from owners to servers (if any)
        logger.debug('[Migration] → Migrating owners data to servers...');
        await db.execute(
          sql.raw(`
          INSERT INTO "servers" ("id", "created_at", "updated_at")
          SELECT "id", COALESCE("created_at", now()), COALESCE("updated_at", now())
          FROM "owners"
          ON CONFLICT ("id") DO NOTHING
        `)
        );
        logger.debug('[Migration] ✓ Migrated owners data to servers');

        // Now safe to drop owners table
        logger.debug('[Migration] → Dropping obsolete owners table...');
        await db.execute(sql.raw(`DROP TABLE IF EXISTS "owners" CASCADE`));
        logger.debug('[Migration] ✓ Dropped obsolete owners table');
      } else {
        logger.debug('[Migration] ⊘ owners table not found, skipping');
      }
    } catch (error) {
      logger.warn(`[Migration] ⚠️ Could not migrate owners → servers: ${error}`);
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
      const hasMessageServerAgents = tables.some(
        (t: any) => t.table_name === 'message_server_agents'
      );

      if (hasServerAgents && !hasMessageServerAgents) {
        // Rename server_agents → message_server_agents
        logger.debug('[Migration] → Renaming server_agents to message_server_agents...');
        await db.execute(sql.raw(`ALTER TABLE "server_agents" RENAME TO "message_server_agents"`));
        logger.debug('[Migration] ✓ Renamed server_agents → message_server_agents');

        // Now rename server_id column → message_server_id
        logger.debug(
          '[Migration] → Renaming message_server_agents.server_id to message_server_id...'
        );
        await db.execute(
          sql.raw(
            `ALTER TABLE "message_server_agents" RENAME COLUMN "server_id" TO "message_server_id"`
          )
        );
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
          logger.debug(
            '[Migration] → Renaming message_server_agents.server_id to message_server_id...'
          );
          await db.execute(
            sql.raw(
              `ALTER TABLE "message_server_agents" RENAME COLUMN "server_id" TO "message_server_id"`
            )
          );
          logger.debug('[Migration] ✓ Renamed message_server_agents.server_id → message_server_id');
        } else if (!hasServerId && !hasMessageServerId) {
          // Table exists but doesn't have either column - truncate it
          logger.debug(
            '[Migration] → message_server_agents exists without required columns, truncating...'
          );
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
        await db.execute(
          sql.raw(`ALTER TABLE "channel_participants" RENAME COLUMN "user_id" TO "entity_id"`)
        );
        logger.debug('[Migration] ✓ Renamed channel_participants.user_id → entity_id');
      } else if (!hasUserId && !hasEntityId) {
        // Table exists but has neither column - truncate it so RuntimeMigrator can add entity_id
        logger.debug(
          '[Migration] → channel_participants exists without entity_id or user_id, truncating...'
        );
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

    // =========================================================================
    // SMOOTH MIGRATION: camelCase → snake_case column renames
    // This ensures a non-destructive transition from v1.6.4 to v1.6.5+
    // All data is preserved through RENAME COLUMN operations
    // This section can be removed once all deployments have been migrated
    // =========================================================================
    logger.debug('[Migration] → Starting camelCase → snake_case column renames...');

    const columnRenames = [
      // rooms table
      { table: 'rooms', from: 'agentId', to: 'agent_id' },
      { table: 'rooms', from: 'worldId', to: 'world_id' },
      { table: 'rooms', from: 'channelId', to: 'channel_id' },
      { table: 'rooms', from: 'createdAt', to: 'created_at' },

      // worlds table
      { table: 'worlds', from: 'agentId', to: 'agent_id' },
      { table: 'worlds', from: 'createdAt', to: 'created_at' },

      // memories table
      { table: 'memories', from: 'createdAt', to: 'created_at' },
      { table: 'memories', from: 'entityId', to: 'entity_id' },
      { table: 'memories', from: 'agentId', to: 'agent_id' },
      { table: 'memories', from: 'roomId', to: 'room_id' },
      { table: 'memories', from: 'worldId', to: 'world_id' },

      // components table
      { table: 'components', from: 'entityId', to: 'entity_id' },
      { table: 'components', from: 'agentId', to: 'agent_id' },
      { table: 'components', from: 'roomId', to: 'room_id' },
      { table: 'components', from: 'worldId', to: 'world_id' },
      { table: 'components', from: 'sourceEntityId', to: 'source_entity_id' },
      { table: 'components', from: 'createdAt', to: 'created_at' },

      // participants table
      { table: 'participants', from: 'entityId', to: 'entity_id' },
      { table: 'participants', from: 'roomId', to: 'room_id' },
      { table: 'participants', from: 'agentId', to: 'agent_id' },
      { table: 'participants', from: 'roomState', to: 'room_state' },
      { table: 'participants', from: 'createdAt', to: 'created_at' },

      // relationships table
      { table: 'relationships', from: 'sourceEntityId', to: 'source_entity_id' },
      { table: 'relationships', from: 'targetEntityId', to: 'target_entity_id' },
      { table: 'relationships', from: 'agentId', to: 'agent_id' },
      { table: 'relationships', from: 'createdAt', to: 'created_at' },

      // logs table
      { table: 'logs', from: 'entityId', to: 'entity_id' },
      { table: 'logs', from: 'roomId', to: 'room_id' },
      { table: 'logs', from: 'createdAt', to: 'created_at' },

      // tasks table
      { table: 'tasks', from: 'roomId', to: 'room_id' },
      { table: 'tasks', from: 'worldId', to: 'world_id' },
      { table: 'tasks', from: 'entityId', to: 'entity_id' },
      { table: 'tasks', from: 'createdAt', to: 'created_at' },
      { table: 'tasks', from: 'updatedAt', to: 'updated_at' },

      // agents table
      { table: 'agents', from: 'createdAt', to: 'created_at' },
      { table: 'agents', from: 'updatedAt', to: 'updated_at' },

      // entities table
      { table: 'entities', from: 'agentId', to: 'agent_id' },
      { table: 'entities', from: 'createdAt', to: 'created_at' },

      // embeddings table
      { table: 'embeddings', from: 'memoryId', to: 'memory_id' },
      { table: 'embeddings', from: 'createdAt', to: 'created_at' },

      // cache table
      { table: 'cache', from: 'agentId', to: 'agent_id' },
      { table: 'cache', from: 'createdAt', to: 'created_at' },
      { table: 'cache', from: 'expiresAt', to: 'expires_at' },
    ];

    for (const rename of columnRenames) {
      try {
        // Check if table exists first
        const tableExistsResult = await db.execute(sql`
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ${rename.table}
        `);

        if (!tableExistsResult.rows || tableExistsResult.rows.length === 0) {
          // Table doesn't exist yet, skip
          continue;
        }

        // Check which columns exist
        const columnsResult = await db.execute(sql`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ${rename.table}
            AND column_name IN (${rename.from}, ${rename.to})
          ORDER BY column_name
        `);

        const columns = columnsResult.rows || [];
        const hasOldColumn = columns.some((c: any) => c.column_name === rename.from);
        const hasNewColumn = columns.some((c: any) => c.column_name === rename.to);

        if (hasOldColumn && !hasNewColumn) {
          // Old column exists, new doesn't → RENAME (preserves data!)
          logger.debug(`[Migration] → Renaming ${rename.table}.${rename.from} to ${rename.to}...`);
          await db.execute(
            sql.raw(
              `ALTER TABLE "${rename.table}" RENAME COLUMN "${rename.from}" TO "${rename.to}"`
            )
          );
          logger.debug(`[Migration] ✓ Renamed ${rename.table}.${rename.from} → ${rename.to}`);
        } else if (hasOldColumn && hasNewColumn) {
          // Both exist → drop old (data should be in new already)
          logger.debug(
            `[Migration] → Both columns exist, dropping ${rename.table}.${rename.from}...`
          );
          await db.execute(
            sql.raw(`ALTER TABLE "${rename.table}" DROP COLUMN "${rename.from}" CASCADE`)
          );
          logger.debug(`[Migration] ✓ Dropped ${rename.table}.${rename.from}`);
        }
        // If only new column exists or neither exists, nothing to do
      } catch (error) {
        // Log but continue - table might not exist yet or column might already be renamed
        logger.debug(`[Migration] ⊘ Could not process ${rename.table}.${rename.from}: ${error}`);
      }
    }

    logger.debug('[Migration] ✓ Completed camelCase → snake_case column renames');

    logger.info('[Migration] ✓ Migration complete - pre-1.6.5 → 1.6.5+ schema migration finished');
  } catch (error) {
    // Re-throw errors to prevent RuntimeMigrator from running on broken state
    logger.error('[Migration] Migration failed:', String(error));
    throw error;
  }
}
