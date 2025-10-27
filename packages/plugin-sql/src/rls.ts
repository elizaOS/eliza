import { logger, stringToUuid, type IDatabaseAdapter } from '@elizaos/core';
import { sql, eq } from 'drizzle-orm';
import { ownersTable } from './schema/owners';
import { agentTable } from './schema/agent';

/**
 * Install PostgreSQL functions required for RLS
 * These are stored procedures that must be created with raw SQL
 */
export async function installRLSFunctions(adapter: IDatabaseAdapter): Promise<void> {
  const db = (adapter as any).getDatabase();

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

      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE information_schema.columns.table_schema = schema_name
          AND information_schema.columns.table_name = add_owner_isolation.table_name
          AND information_schema.columns.column_name = 'owner_id'
      ) INTO column_exists;

      IF NOT column_exists THEN
        EXECUTE format('ALTER TABLE %I.%I ADD COLUMN owner_id UUID DEFAULT current_owner_id()', schema_name, table_name);
      END IF;

      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_owner_id ON %I.%I(owner_id)', table_name, schema_name, table_name);
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', schema_name, table_name);
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', schema_name, table_name);
      EXECUTE format('DROP POLICY IF EXISTS owner_isolation_policy ON %I.%I', schema_name, table_name);
      EXECUTE format('
        CREATE POLICY owner_isolation_policy ON %I.%I
        USING (owner_id = current_owner_id() OR owner_id IS NULL)
        WITH CHECK (owner_id = current_owner_id() OR owner_id IS NULL)
      ', schema_name, table_name);
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Function to apply RLS to all tables
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
  const db = (adapter as any).getDatabase();
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
 * This function just validates that the owner exists
 */
export async function setOwnerContext(
  adapter: IDatabaseAdapter,
  ownerId: string
): Promise<void> {
  // Validate owner exists
  const db = (adapter as any).getDatabase();
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
  const db = (adapter as any).getDatabase();

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
 * Remove owner_id from agent when RLS is disabled using Drizzle ORM
 */
export async function cleanupOwnerIfDisabled(
  adapter: IDatabaseAdapter,
  agentId: string
): Promise<void> {
  const db = (adapter as any).getDatabase();

  const agents = await db.select().from(agentTable).where(eq(agentTable.id, agentId));

  if (agents.length > 0 && agents[0].owner_id !== null) {
    await db.update(agentTable).set({ owner_id: null }).where(eq(agentTable.id, agentId));

    logger.info(`[RLS] Owner removed from agent ${agents[0].name}`);
  }
}

/**
 * Apply RLS to all tables by calling PostgreSQL function
 */
export async function applyRLSToNewTables(adapter: IDatabaseAdapter): Promise<void> {
  const db = (adapter as any).getDatabase();

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
 */
export async function uninstallRLS(adapter: IDatabaseAdapter): Promise<void> {
  const db = (adapter as any).getDatabase();

  try {
    logger.info('[RLS] Disabling RLS (keeping owner_id columns for schema compatibility)...');

    // 1. Drop all RLS policies and disable RLS on all tables
    const tablesResult = await db.execute(sql`
      SELECT schemaname, tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('drizzle_migrations', '__drizzle_migrations')
    `);

    for (const row of tablesResult.rows || []) {
      const tableName = row.tablename;

      try {
        // Drop all policies on this table
        const policiesResult = await db.execute(sql.raw(`
          SELECT policyname
          FROM pg_policies
          WHERE schemaname = 'public' AND tablename = '${tableName}'
        `));

        for (const policy of policiesResult.rows || []) {
          await db.execute(sql.raw(`
            DROP POLICY IF EXISTS ${policy.policyname} ON ${tableName}
          `));
        }

        // Disable RLS (but keep FORCE disabled)
        await db.execute(sql.raw(`
          ALTER TABLE ${tableName} NO FORCE ROW LEVEL SECURITY
        `));

        await db.execute(sql.raw(`
          ALTER TABLE ${tableName} DISABLE ROW LEVEL SECURITY
        `));

        // NOTE: We intentionally KEEP the owner_id column for Drizzle schema compatibility
        // It will just be NULL or unused when RLS is disabled

        logger.debug(`[RLS] Disabled RLS on table: ${tableName}`);
      } catch (error) {
        logger.warn(`[RLS] Failed to disable RLS on table ${tableName}:`, String(error));
      }
    }

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
