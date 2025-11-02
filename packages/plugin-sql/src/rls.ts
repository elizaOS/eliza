import { logger, validateUuid, type IDatabaseAdapter } from '@elizaos/core';
import { sql, eq } from 'drizzle-orm';
import { serverTable } from './schema/server';
import { agentTable } from './schema/agent';

/**
 * PostgreSQL Row-Level Security (RLS) for Multi-Server and Entity Isolation
 *
 * This module provides two layers of database-level security:
 *
 * 1. **Server RLS** - Multi-server isolation
 *    - Isolates data between different ElizaOS server instances
 *    - Uses `server_id` column added dynamically to all tables
 *    - Server context set via PostgreSQL `application_name` connection parameter
 *    - Prevents data leakage between different deployments/environments
 *
 * 2. **Entity RLS** - User/agent-level privacy isolation
 *    - Isolates data between different users (Clients (plugins/API) users)
 *    - Uses `entity_id`, `author_id`, or joins via `participants` table
 *    - Entity context set via `app.entity_id` transaction-local variable
 *    - Provides DM privacy and multi-user isolation within a server
 *
 * CRITICAL SECURITY REQUIREMENTS:
 * - RLS policies DO NOT apply to PostgreSQL superuser accounts
 * - Use a REGULAR (non-superuser) database user
 * - Grant only necessary permissions (CREATE, SELECT, INSERT, UPDATE, DELETE)
 * - NEVER use the 'postgres' superuser or any superuser account
 * - Superusers bypass ALL RLS policies by design, defeating the isolation mechanism
 *
 * ARCHITECTURE:
 * - Server RLS: Uses PostgreSQL `application_name` (set at connection pool level)
 * - Entity RLS: Uses `SET LOCAL app.entity_id` (set per transaction)
 * - Policies use FORCE ROW LEVEL SECURITY to enforce even for table owners
 * - Automatic index creation for performance (`server_id`, `entity_id`, `room_id`)
 *
 * @module rls
 */

/**
 * Install PostgreSQL functions required for Server RLS and Entity RLS
 *
 * This function creates all necessary PostgreSQL stored procedures for both
 * Server RLS (multi-server isolation) and Entity RLS (user privacy isolation).
 *
 * **Server RLS Functions Created:**
 * - `current_server_id()` - Returns server UUID from `application_name`
 * - `add_server_isolation(schema, table)` - Adds Server RLS to a single table
 * - `apply_rls_to_all_tables()` - Applies Server RLS to all eligible tables
 *
 * **Entity RLS Functions Created:**
 * - `current_entity_id()` - Returns entity UUID from `app.entity_id` session variable
 * - `add_entity_isolation(schema, table)` - Adds Entity RLS to a single table
 * - `apply_entity_rls_to_all_tables()` - Applies Entity RLS to all eligible tables
 *
 * **Security Model:**
 * - Server RLS: Isolation between different ElizaOS instances (environments/deployments)
 * - Entity RLS: Isolation between different users within a server instance
 * - Both layers stack - a user can only see data from their server AND their accessible entities
 *
 * **Important Notes:**
 * - Must be called before `applyRLSToNewTables()` or `applyEntityRLSToAllTables()`
 * - Creates `servers` table if it doesn't exist
 * - Automatically calls `installEntityRLS()` to set up both layers
 * - Uses `%I` identifier quoting in format() to prevent SQL injection
 * - Policies use FORCE RLS to enforce even for table owners
 *
 * @param adapter - Database adapter with access to the Drizzle ORM instance
 * @returns Promise that resolves when all RLS functions are installed
 * @throws {Error} If database connection fails or SQL execution fails
 *
 * @example
 * ```typescript
 * // Install RLS functions on server startup
 * await installRLSFunctions(database);
 * await getOrCreateRlsServer(database, serverId);
 * await setServerContext(database, serverId);
 * await applyRLSToNewTables(database);
 * ```
 */
export async function installRLSFunctions(adapter: IDatabaseAdapter): Promise<void> {
  const db = adapter.db;

  // Create servers table if it doesn't exist
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS servers (
      id UUID PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    )
  `);

  // Function to get server_id from application_name
  // This allows multi-tenant isolation without needing superuser privileges
  // Each connection pool sets application_name = server_id
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION current_server_id() RETURNS UUID AS $$
    DECLARE
      app_name TEXT;
    BEGIN
      app_name := NULLIF(current_setting('application_name', TRUE), '');

      -- Return NULL if application_name is not set or not a valid UUID
      -- This allows admin queries to work without RLS restrictions
      BEGIN
        RETURN app_name::UUID;
      EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
      END;
    END;
    $$ LANGUAGE plpgsql STABLE;
  `);

  // Function to add RLS to a table
  // SECURITY: Uses format() with %I to safely quote identifiers and prevent SQL injection
  // This function:
  // 1. Adds server_id column if it doesn't exist (with DEFAULT current_server_id())
  // 2. Backfills/reassigns orphaned data to current server
  // 3. Creates an index on server_id for query performance
  // 4. Enables FORCE ROW LEVEL SECURITY (enforces RLS even for table owners)
  // 5. Creates an isolation policy that filters rows by server_id
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION add_server_isolation(
      schema_name text,
      table_name text
    ) RETURNS void AS $$
    DECLARE
      full_table_name text;
      column_exists boolean;
      orphaned_count bigint;
    BEGIN
      full_table_name := schema_name || '.' || table_name;

      -- Check if server_id column already exists
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE information_schema.columns.table_schema = schema_name
          AND information_schema.columns.table_name = add_server_isolation.table_name
          AND information_schema.columns.column_name = 'server_id'
      ) INTO column_exists;

      -- Add server_id column if missing (DEFAULT populates it automatically for new rows)
      IF NOT column_exists THEN
        EXECUTE format('ALTER TABLE %I.%I ADD COLUMN server_id UUID DEFAULT current_server_id()', schema_name, table_name);

        -- Backfill existing rows with current server_id
        -- This ensures all existing data belongs to the server instance that is enabling RLS
        EXECUTE format('UPDATE %I.%I SET server_id = current_server_id() WHERE server_id IS NULL', schema_name, table_name);
      ELSE
        -- Column already exists (RLS was previously enabled then disabled)
        -- Restore the DEFAULT clause (may have been removed during uninstallRLS)
        EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN server_id SET DEFAULT current_server_id()', schema_name, table_name);

        -- Only backfill NULL server_id rows, do NOT steal data from other servers
        EXECUTE format('SELECT COUNT(*) FROM %I.%I WHERE server_id IS NULL', schema_name, table_name) INTO orphaned_count;

        IF orphaned_count > 0 THEN
          RAISE NOTICE 'Backfilling % rows with NULL server_id in %.%', orphaned_count, schema_name, table_name;
          EXECUTE format('UPDATE %I.%I SET server_id = current_server_id() WHERE server_id IS NULL', schema_name, table_name);
        END IF;
      END IF;

      -- Create index for efficient server_id filtering
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_server_id ON %I.%I(server_id)', table_name, schema_name, table_name);

      -- Enable RLS on the table
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', schema_name, table_name);

      -- FORCE RLS even for table owners (critical for security)
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', schema_name, table_name);

      -- Drop existing policy if present
      EXECUTE format('DROP POLICY IF EXISTS server_isolation_policy ON %I.%I', schema_name, table_name);

      -- Create isolation policy: users can only see/modify rows where server_id matches current server instance
      -- No NULL clause - all rows must have a valid server_id (backfilled during column addition)
      EXECUTE format('
        CREATE POLICY server_isolation_policy ON %I.%I
        USING (server_id = current_server_id())
        WITH CHECK (server_id = current_server_id())
      ', schema_name, table_name);
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Function to apply RLS to all tables
  // SCHEMA COVERAGE: This function automatically applies RLS to ALL tables in the 'public' schema
  // including: agents, rooms, memories, messages, participants, channels, embeddings, relationships,
  // entities, logs, cache, components, tasks, world, message_servers, etc.
  //
  // EXCLUDED tables (not isolated):
  // - servers (contains all server instance IDs, shared for multi-tenant management)
  // - drizzle_migrations, __drizzle_migrations (migration tracking tables)
  // - server_agents (junction table - agents and message_servers already have RLS)
  //
  // This dynamic approach ensures plugin tables are automatically protected when added.
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION apply_rls_to_all_tables() RETURNS void AS $$
    DECLARE
      tbl record;
    BEGIN
      FOR tbl IN
        SELECT schemaname, tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN (
            'servers',
            'drizzle_migrations',
            '__drizzle_migrations',
            'server_agents'
          )
      LOOP
        BEGIN
          PERFORM add_server_isolation(tbl.schemaname, tbl.tablename);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'Failed to apply RLS to %.%: %', tbl.schemaname, tbl.tablename, SQLERRM;
        END;
      END LOOP;
    END;
    $$ LANGUAGE plpgsql;
  `);

  logger.info('[RLS] PostgreSQL functions installed');

  // Install Entity RLS functions as well (part of unified RLS system)
  await installEntityRLS(adapter);
}

/**
 * Get or create RLS server using Drizzle ORM
 */
export async function getOrCreateRlsServer(
  adapter: IDatabaseAdapter,
  serverId: string
): Promise<string> {
  const db = adapter.db;

  // Use Drizzle's insert with onConflictDoNothing
  await db
    .insert(serverTable)
    .values({
      id: serverId,
    })
    .onConflictDoNothing();

  logger.info(`[RLS] Server: ${serverId.slice(0, 8)}…`);
  return serverId;
}

/**
 * Set RLS context on PostgreSQL connection pool
 * This function validates that the server exists and has correct UUID format
 */
export async function setServerContext(
  adapter: IDatabaseAdapter,
  serverId: string
): Promise<void> {
  // Validate UUID format using @elizaos/core utility
  if (!validateUuid(serverId)) {
    throw new Error(`Invalid server ID format: ${serverId}. Must be a valid UUID.`);
  }

  // Validate server exists
  const db = adapter.db;
  const servers = await db.select().from(serverTable).where(eq(serverTable.id, serverId));

  if (servers.length === 0) {
    throw new Error(`Server ${serverId} does not exist`);
  }

  logger.info(`[RLS] Server: ${serverId.slice(0, 8)}…`);
  logger.info('[RLS] Context configured successfully (using application_name)');
}

/**
 * Assign agent to server using Drizzle ORM
 */
export async function assignAgentToServer(
  adapter: IDatabaseAdapter,
  agentId: string,
  serverId: string
): Promise<void> {
  const db = adapter.db;

  // Check if agent exists using Drizzle
  const agents = await db.select().from(agentTable).where(eq(agentTable.id, agentId));

  if (agents.length > 0) {
    const agent = agents[0];
    const currentServerId = agent.server_id;

    if (currentServerId === serverId) {
      logger.debug(`[RLS] Agent ${agent.name} already assigned to correct server`);
    } else {
      // Update agent server using Drizzle
      await db
        .update(agentTable)
        .set({ server_id: serverId })
        .where(eq(agentTable.id, agentId));

      if (currentServerId === null) {
        logger.info(`[RLS] Agent ${agent.name} assigned to server`);
      } else {
        logger.warn(`[RLS] Agent ${agent.name} server changed`);
      }
    }
  } else {
    logger.debug(`[RLS] Agent ${agentId} doesn't exist yet`);
  }
}

/**
 * Apply RLS to all tables by calling PostgreSQL function
 */
export async function applyRLSToNewTables(adapter: IDatabaseAdapter): Promise<void> {
  const db = adapter.db;

  try {
    await db.execute(sql`SELECT apply_rls_to_all_tables()`);
    logger.info('[RLS] Applied to all tables');
  } catch (error) {
    logger.warn('[RLS] Failed to apply to some tables:', String(error));
  }
}

/**
 * Disable RLS globally
 * SIMPLE APPROACH:
 * - Disables RLS for ALL server instances
 * - Keeps server_id columns and data intact
 * - Use only in development or when migrating to single-server mode
 */
export async function uninstallRLS(adapter: IDatabaseAdapter): Promise<void> {
  const db = adapter.db;

  try {
    // Check if RLS is actually enabled by checking if the servers table exists
    const checkResult = await db.execute(sql`
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'servers'
      ) as rls_enabled
    `);

    const rlsEnabled = checkResult.rows?.[0]?.rls_enabled;

    if (!rlsEnabled) {
      logger.debug('[RLS] RLS not installed, skipping cleanup');
      return;
    }

    logger.info('[RLS] Disabling RLS globally (keeping server_id columns for schema compatibility)...');

    // First, uninstall Entity RLS (depends on Server RLS)
    try {
      await uninstallEntityRLS(adapter);
    } catch (entityRlsError) {
      logger.debug('[RLS] Entity RLS cleanup skipped (not installed or already cleaned)');
    }

    // Create a temporary stored procedure to safely drop policies and disable RLS
    // Using format() with %I ensures proper identifier quoting and prevents SQL injection
    await db.execute(sql`
      CREATE OR REPLACE FUNCTION _temp_disable_rls_on_table(
        p_schema_name text,
        p_table_name text
      ) RETURNS void AS $$
      DECLARE
        policy_rec record;
      BEGIN
        -- Drop all policies on this table
        FOR policy_rec IN
          SELECT policyname
          FROM pg_policies
          WHERE schemaname = p_schema_name AND tablename = p_table_name
        LOOP
          EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
            policy_rec.policyname, p_schema_name, p_table_name);
        END LOOP;

        -- Disable RLS
        EXECUTE format('ALTER TABLE %I.%I NO FORCE ROW LEVEL SECURITY', p_schema_name, p_table_name);
        EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', p_schema_name, p_table_name);
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Get all tables in public schema
    const tablesResult = await db.execute(sql`
      SELECT schemaname, tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('drizzle_migrations', '__drizzle_migrations')
    `);

    // Safely disable RLS on each table using the stored procedure
    for (const row of tablesResult.rows || []) {
      const schemaName = row.schemaname;
      const tableName = row.tablename;

      try {
        // Call stored procedure with parameterized query (safe from SQL injection)
        await db.execute(sql`SELECT _temp_disable_rls_on_table(${schemaName}, ${tableName})`);
        logger.debug(`[RLS] Disabled RLS on table: ${schemaName}.${tableName}`);
      } catch (error) {
        logger.warn(`[RLS] Failed to disable RLS on table ${schemaName}.${tableName}:`, String(error));
      }
    }

    // Drop the temporary function
    await db.execute(sql`DROP FUNCTION IF EXISTS _temp_disable_rls_on_table(text, text)`);

    // 2. KEEP server_id values intact (do NOT clear them)
    // This prevents data theft when re-enabling RLS:
    // - Each row keeps its original server_id
    // - When RLS is re-enabled, only NULL rows are backfilled (new data created while RLS was off)
    // - Existing data remains owned by its original server instance
    logger.info('[RLS] Keeping server_id values intact (prevents data theft on re-enable)');

    // 3. Keep the servers table structure but clear it
    // When RLS is re-enabled, servers will be re-created from server initialization
    logger.info('[RLS] Clearing servers table...');
    await db.execute(sql`TRUNCATE TABLE servers`);

    // 4. Drop all RLS functions
    await db.execute(sql`DROP FUNCTION IF EXISTS apply_rls_to_all_tables() CASCADE`);
    await db.execute(sql`DROP FUNCTION IF EXISTS add_server_isolation(text, text) CASCADE`);
    await db.execute(sql`DROP FUNCTION IF EXISTS current_server_id() CASCADE`);
    logger.info('[RLS] Dropped all RLS functions');

    logger.success('[RLS] RLS disabled successfully (server_id columns preserved)');
  } catch (error) {
    logger.error('[RLS] Failed to disable RLS:', String(error));
    throw error;
  }
}

// ============================================================================
// ENTITY RLS
// ============================================================================

/**
 * Install Entity RLS functions for user privacy isolation
 *
 * This provides database-level privacy between different entities (client users: Plugins/API)
 * interacting with agents, independent of JWT authentication.
 *
 * **How Entity RLS Works:**
 * - Each database transaction sets `app.entity_id` before querying
 * - Policies filter rows based on entity ownership or participant membership
 * - Two isolation strategies:
 *   1. Direct ownership: `entity_id` or `author_id` column matches `current_entity_id()`
 *   2. Shared access: `room_id`/`channel_id` exists in `participants` table for the entity
 *
 * **Performance Considerations:**
 * - **Subquery policies** (for `room_id`/`channel_id`) run on EVERY row access
 * - Indexes are automatically created on: `entity_id`, `author_id`, `room_id`, `channel_id`
 * - The `participants` table should have an index on `(entity_id, channel_id)`
 * - For large datasets (>1M rows), consider:
 *   - Materialized views for frequently accessed entity-filtered data
 *   - Partitioning large tables by date or entity_id
 *
 * **Optimization Tips:**
 * - Direct column policies (`entity_id = current_entity_id()`) are faster than subquery policies
 * - The `participants` lookup is cached per transaction but still requires index scans
 *
 * **Tables Excluded from Entity RLS:**
 * - `servers` - Server RLS table
 * - `users` - Authentication (no entity isolation)
 * - `entity_mappings` - Cross-platform entity mapping
 * - `agents` - Shared across all entities
 * - `drizzle_migrations`, `__drizzle_migrations` - Migration tracking
 * - `server_agents` - Junction table
 *
 * @param adapter - Database adapter with access to the Drizzle ORM instance
 * @returns Promise that resolves when Entity RLS functions are installed
 * @throws {Error} If database connection fails or SQL execution fails
 *
 * @example
 * ```typescript
 * // Called automatically by installRLSFunctions()
 * await installRLSFunctions(database);
 *
 * // Or call separately if needed
 * await installEntityRLS(database);
 * await applyEntityRLSToAllTables(database);
 * ```
 */
export async function installEntityRLS(adapter: IDatabaseAdapter): Promise<void> {
  const db = adapter.db;

  logger.info('[Entity RLS] Installing entity RLS functions and policies...');

  // 1. Create current_entity_id() function - reads from app.entity_id session variable
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION current_entity_id()
    RETURNS UUID AS $$
    DECLARE
      entity_id_text TEXT;
    BEGIN
      -- Read from transaction-local variable
      entity_id_text := NULLIF(current_setting('app.entity_id', TRUE), '');

      IF entity_id_text IS NULL OR entity_id_text = '' THEN
        RETURN NULL;
      END IF;

      BEGIN
        RETURN entity_id_text::UUID;
      EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
      END;
    END;
    $$ LANGUAGE plpgsql STABLE;
  `);

  logger.info('[Entity RLS] Created current_entity_id() function');

  // 2. Create add_entity_isolation() function - applies entity RLS to a single table
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION add_entity_isolation(
      schema_name text,
      table_name text
    ) RETURNS void AS $$
    DECLARE
      full_table_name text;
      has_entity_id boolean;
      has_author_id boolean;
      has_channel_id boolean;
      has_room_id boolean;
      entity_column_name text;
      room_column_name text;
    BEGIN
      full_table_name := schema_name || '.' || table_name;

      -- Check which columns exist
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE information_schema.columns.table_schema = schema_name
          AND information_schema.columns.table_name = add_entity_isolation.table_name
          AND information_schema.columns.column_name = 'entity_id'
      ) INTO has_entity_id;

      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE information_schema.columns.table_schema = schema_name
          AND information_schema.columns.table_name = add_entity_isolation.table_name
          AND information_schema.columns.column_name = 'author_id'
      ) INTO has_author_id;

      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE information_schema.columns.table_schema = schema_name
          AND information_schema.columns.table_name = add_entity_isolation.table_name
          AND information_schema.columns.column_name = 'channel_id'
      ) INTO has_channel_id;

      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE information_schema.columns.table_schema = schema_name
          AND information_schema.columns.table_name = add_entity_isolation.table_name
          AND information_schema.columns.column_name = 'room_id'
      ) INTO has_room_id;

      -- Skip if no entity-related columns
      IF NOT (has_entity_id OR has_author_id OR has_channel_id OR has_room_id) THEN
        RAISE NOTICE '[Entity RLS] Skipping %.%: no entity columns found', schema_name, table_name;
        RETURN;
      END IF;

      -- Determine which column to use for entity filtering
      -- Priority: room_id/channel_id (shared access via participants) > entity_id/author_id (direct access)
      --
      -- SECURITY NOTE: Column names are hardcoded string literals (not user input)
      -- This prevents SQL injection even though they're used in format() with %I
      -- The %I identifier quoting protects against malicious column names in the schema
      IF has_room_id THEN
        room_column_name := 'room_id';
        entity_column_name := NULL;
      ELSIF has_channel_id THEN
        room_column_name := 'channel_id';
        entity_column_name := NULL;
      ELSIF has_entity_id THEN
        entity_column_name := 'entity_id';
        room_column_name := NULL;
      ELSIF has_author_id THEN
        entity_column_name := 'author_id';
        room_column_name := NULL;
      ELSE
        entity_column_name := NULL;
        room_column_name := NULL;
      END IF;

      -- Validate column names are from our whitelist (defense in depth)
      IF room_column_name IS NOT NULL AND room_column_name NOT IN ('room_id', 'channel_id') THEN
        RAISE EXCEPTION '[Entity RLS] Invalid room column name: %', room_column_name;
      END IF;
      IF entity_column_name IS NOT NULL AND entity_column_name NOT IN ('entity_id', 'author_id') THEN
        RAISE EXCEPTION '[Entity RLS] Invalid entity column name: %', entity_column_name;
      END IF;

      -- Enable RLS on the table
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', schema_name, table_name);
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', schema_name, table_name);

      -- Drop existing entity policies if present
      EXECUTE format('DROP POLICY IF EXISTS entity_isolation_policy ON %I.%I', schema_name, table_name);

      -- CASE 1: Table has room_id or channel_id (shared access via participants)
      IF room_column_name IS NOT NULL THEN
        EXECUTE format('
          CREATE POLICY entity_isolation_policy ON %I.%I
          USING (
            current_entity_id() IS NULL
            OR %I IN (
              SELECT channel_id
              FROM participants
              WHERE entity_id = current_entity_id()
            )
          )
          WITH CHECK (
            current_entity_id() IS NULL
            OR %I IN (
              SELECT channel_id
              FROM participants
              WHERE entity_id = current_entity_id()
            )
          )
        ', schema_name, table_name, room_column_name, room_column_name);

        RAISE NOTICE '[Entity RLS] Applied to %.% (via % → participants)', schema_name, table_name, room_column_name;

      -- CASE 2: Table has direct entity_id or author_id column
      ELSIF entity_column_name IS NOT NULL THEN
        EXECUTE format('
          CREATE POLICY entity_isolation_policy ON %I.%I
          USING (
            current_entity_id() IS NULL
            OR %I = current_entity_id()
          )
          WITH CHECK (
            current_entity_id() IS NULL
            OR %I = current_entity_id()
          )
        ', schema_name, table_name, entity_column_name, entity_column_name);

        RAISE NOTICE '[Entity RLS] Applied to %.% (direct column: %)', schema_name, table_name, entity_column_name;
      END IF;

      -- Create indexes for efficient entity filtering
      IF room_column_name IS NOT NULL THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_room ON %I.%I(%I)',
          table_name, schema_name, table_name, room_column_name);
      END IF;

      IF entity_column_name IS NOT NULL THEN
        EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_entity ON %I.%I(%I)',
          table_name, schema_name, table_name, entity_column_name);
      END IF;
    END;
    $$ LANGUAGE plpgsql;
  `);

  logger.info('[Entity RLS] Created add_entity_isolation() function');

  // 3. Create apply_entity_rls_to_all_tables() function - applies to all eligible tables
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION apply_entity_rls_to_all_tables() RETURNS void AS $$
    DECLARE
      tbl record;
    BEGIN
      FOR tbl IN
        SELECT schemaname, tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN (
            'servers',              -- Server RLS table
            'users',                -- Authentication table (no entity isolation needed)
            'entity_mappings',      -- Mapping table (no entity isolation needed)
            'drizzle_migrations',   -- Migration tracking
            '__drizzle_migrations', -- Migration tracking
            'agents',               -- Agents are not entity-specific
            'server_agents'         -- Junction table
          )
      LOOP
        BEGIN
          PERFORM add_entity_isolation(tbl.schemaname, tbl.tablename);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '[Entity RLS] Failed to apply to %.%: %', tbl.schemaname, tbl.tablename, SQLERRM;
        END;
      END LOOP;
    END;
    $$ LANGUAGE plpgsql;
  `);

  logger.info('[Entity RLS] Created apply_entity_rls_to_all_tables() function');

  // 4. Apply Entity RLS to all eligible tables automatically
  try {
    await db.execute(sql`SELECT apply_entity_rls_to_all_tables()`);
    logger.info('[Entity RLS] Applied entity RLS to all eligible tables');
  } catch (error) {
    logger.warn('[Entity RLS] Failed to apply entity RLS to some tables:', String(error));
  }

  logger.info('[Entity RLS] Entity RLS functions installed and applied successfully');
}

/**
 * Apply Entity RLS policies to all eligible tables
 * Call this after installEntityRLS() to activate the policies
 */
export async function applyEntityRLSToAllTables(adapter: IDatabaseAdapter): Promise<void> {
  const db = adapter.db;

  try {
    await db.execute(sql`SELECT apply_entity_rls_to_all_tables()`);
    logger.info('[Entity RLS] Applied entity RLS to all eligible tables');
  } catch (error) {
    logger.warn('[Entity RLS] Failed to apply entity RLS to some tables:', String(error));
  }
}

/**
 * Remove Entity RLS (for rollback or testing)
 * Drops entity RLS functions and policies but keeps server RLS intact
 */
export async function uninstallEntityRLS(adapter: IDatabaseAdapter): Promise<void> {
  const db = adapter.db;

  logger.info('[Entity RLS] Removing entity RLS policies and functions...');

  try {
    // First, drop all entity_isolation_policy policies from all tables
    const tablesResult = await db.execute(sql`
      SELECT schemaname, tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('drizzle_migrations', '__drizzle_migrations')
    `);

    for (const row of tablesResult.rows || []) {
      const schemaName = row.schemaname;
      const tableName = row.tablename;

      try {
        // Drop entity_isolation_policy if it exists
        await db.execute(
          sql.raw(`DROP POLICY IF EXISTS entity_isolation_policy ON ${schemaName}.${tableName}`)
        );
        logger.debug(`[Entity RLS] Dropped entity_isolation_policy from ${schemaName}.${tableName}`);
      } catch (error) {
        logger.debug(`[Entity RLS] No entity policy on ${schemaName}.${tableName}`);
      }
    }

    // Drop the apply function (CASCADE will drop dependencies)
    await db.execute(sql`DROP FUNCTION IF EXISTS apply_entity_rls_to_all_tables() CASCADE`);
    await db.execute(sql`DROP FUNCTION IF EXISTS add_entity_isolation(text, text) CASCADE`);
    await db.execute(sql`DROP FUNCTION IF EXISTS current_entity_id() CASCADE`);

    logger.info('[Entity RLS] Entity RLS functions and policies removed successfully');
  } catch (error) {
    logger.error('[Entity RLS] Failed to remove entity RLS:', String(error));
    throw error;
  }
}
