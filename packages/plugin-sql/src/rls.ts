import { logger, stringToUuid, validateUuid, type IDatabaseAdapter } from '@elizaos/core';
import { sql, eq } from 'drizzle-orm';
import { ownersTable } from './schema/owners';
import { agentTable } from './schema/agent';

/**
 * PostgreSQL Row-Level Security (RLS) for Multi-Tenant Isolation
 *
 * REQUIREMENT:
 * - RLS policies DO NOT apply to PostgreSQL superuser accounts.
 * - Use a REGULAR (non-superuser) database user
 * - Grant only necessary permissions (CREATE, SELECT, INSERT, UPDATE, DELETE)
 * - NEVER use the 'postgres' superuser or any superuser account
 *
 * Superusers bypass ALL RLS policies by design, which would completely
 * defeat the multi-tenant isolation mechanism.
 */

/**
 * Install PostgreSQL functions required for RLS
 * These are stored procedures that must be created with raw SQL
 */
export async function installRLSFunctions(adapter: IDatabaseAdapter): Promise<void> {
  const db = adapter.db;

  // Create owners table if it doesn't exist
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS owners (
      id UUID PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    )
  `);

  // Function to get owner_id from application_name
  // This allows multi-tenant isolation without needing superuser privileges
  // Each connection pool sets application_name = owner_id
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION current_owner_id() RETURNS UUID AS $$
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
  // 1. Adds owner_id column if it doesn't exist (with DEFAULT current_owner_id())
  // 2. Creates an index on owner_id for query performance
  // 3. Enables FORCE ROW LEVEL SECURITY (enforces RLS even for table owners)
  // 4. Creates an isolation policy that filters rows by owner_id
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION add_owner_isolation(
      schema_name text,
      table_name text
    ) RETURNS void AS $$
    DECLARE
      full_table_name text;
      column_exists boolean;
    BEGIN
      full_table_name := schema_name || '.' || table_name;

      -- Check if owner_id column already exists
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE information_schema.columns.table_schema = schema_name
          AND information_schema.columns.table_name = add_owner_isolation.table_name
          AND information_schema.columns.column_name = 'owner_id'
      ) INTO column_exists;

      -- Add owner_id column if missing (DEFAULT populates it automatically for new rows)
      IF NOT column_exists THEN
        EXECUTE format('ALTER TABLE %I.%I ADD COLUMN owner_id UUID DEFAULT current_owner_id()', schema_name, table_name);
      END IF;

      -- Create index for efficient owner_id filtering
      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_owner_id ON %I.%I(owner_id)', table_name, schema_name, table_name);

      -- Enable RLS on the table
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', schema_name, table_name);

      -- FORCE RLS even for table owners (critical for security)
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', schema_name, table_name);

      -- Drop existing policy if present
      EXECUTE format('DROP POLICY IF EXISTS owner_isolation_policy ON %I.%I', schema_name, table_name);

      -- Create isolation policy: users can only see/modify rows where owner_id matches
      -- OR owner_id IS NULL (for backward compatibility with pre-RLS data)
      EXECUTE format('
        CREATE POLICY owner_isolation_policy ON %I.%I
        USING (owner_id = current_owner_id() OR owner_id IS NULL)
        WITH CHECK (owner_id = current_owner_id() OR owner_id IS NULL)
      ', schema_name, table_name);
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Function to apply RLS to all tables
  // SCHEMA COVERAGE: This function automatically applies RLS to ALL tables in the 'public' schema
  // including: agents, rooms, memories, messages, participants, channels, embeddings, relationships,
  // entities, logs, cache, components, tasks, world, message_servers, server_agents, etc.
  //
  // EXCLUDED tables (not isolated):
  // - owners (contains all tenant IDs, shared across tenants)
  // - drizzle_migrations, __drizzle_migrations (migration tracking tables)
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
            'owners',
            'drizzle_migrations',
            '__drizzle_migrations'
          )
      LOOP
        BEGIN
          PERFORM add_owner_isolation(tbl.schemaname, tbl.tablename);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'Failed to apply RLS to %.%: %', tbl.schemaname, tbl.tablename, SQLERRM;
        END;
      END LOOP;
    END;
    $$ LANGUAGE plpgsql;
  `);

  logger.info('[RLS] PostgreSQL functions installed');
}

/**
 * Get or create owner from auth token using Drizzle ORM
 */
export async function getOwnerFromAuthToken(
  adapter: IDatabaseAdapter,
  authToken: string
): Promise<string> {
  const db = adapter.db;
  const owner_id = stringToUuid(authToken);

  // Use Drizzle's insert with onConflictDoNothing
  await db
    .insert(ownersTable)
    .values({
      id: owner_id,
    })
    .onConflictDoNothing();

  logger.info(`[RLS] Owner: ${owner_id}`);
  return owner_id;
}

/**
 * Set RLS context on PostgreSQL connection pool
 * This function validates that the owner exists and has correct UUID format
 */
export async function setOwnerContext(
  adapter: IDatabaseAdapter,
  ownerId: string
): Promise<void> {
  // Validate UUID format using @elizaos/core utility
  if (!validateUuid(ownerId)) {
    throw new Error(`Invalid owner ID format: ${ownerId}. Must be a valid UUID.`);
  }

  // Validate owner exists
  const db = adapter.db;
  const owners = await db.select().from(ownersTable).where(eq(ownersTable.id, ownerId));

  if (owners.length === 0) {
    throw new Error(`Owner ${ownerId} does not exist`);
  }

  logger.info(`[RLS] Owner: ${ownerId}`);
  logger.info('[RLS] Context configured successfully (using application_name)');
}

/**
 * Assign agent to owner using Drizzle ORM
 */
export async function assignAgentToOwner(
  adapter: IDatabaseAdapter,
  agentId: string,
  ownerId: string
): Promise<void> {
  const db = adapter.db;

  // Check if agent exists using Drizzle
  const agents = await db.select().from(agentTable).where(eq(agentTable.id, agentId));

  if (agents.length > 0) {
    const agent = agents[0];
    const currentOwnerId = agent.owner_id;

    if (currentOwnerId === ownerId) {
      logger.debug(`[RLS] Agent ${agent.name} already owned by correct owner`);
    } else {
      // Update agent owner using Drizzle
      await db
        .update(agentTable)
        .set({ owner_id: ownerId })
        .where(eq(agentTable.id, agentId));

      if (currentOwnerId === null) {
        logger.info(`[RLS] Agent ${agent.name} assigned to owner`);
      } else {
        logger.warn(`[RLS] Agent ${agent.name} owner changed`);
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
 * Disable RLS from the database
 * Removes RLS policies and functions but KEEPS owner_id column for schema compatibility
 *
 */
export async function uninstallRLS(adapter: IDatabaseAdapter): Promise<void> {
  const db = adapter.db;

  try {
    logger.info('[RLS] Disabling RLS (keeping owner_id columns for schema compatibility)...');

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

    // 2. Drop the owners table (not needed when RLS is off)
    await db.execute(sql`DROP TABLE IF EXISTS owners CASCADE`);
    logger.info('[RLS] Dropped owners table');

    // 3. Drop all RLS functions
    await db.execute(sql`DROP FUNCTION IF EXISTS apply_rls_to_all_tables() CASCADE`);
    await db.execute(sql`DROP FUNCTION IF EXISTS add_owner_isolation(text, text) CASCADE`);
    await db.execute(sql`DROP FUNCTION IF EXISTS current_owner_id() CASCADE`);
    logger.info('[RLS] Dropped all RLS functions');

    logger.success('[RLS] RLS disabled successfully (owner_id columns preserved)');
  } catch (error) {
    logger.error('[RLS] Failed to disable RLS:', String(error));
    throw error;
  }
}
