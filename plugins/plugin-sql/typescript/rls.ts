import { type IDatabaseAdapter, logger, validateUuid } from "@elizaos/core";
import { eq, sql } from "drizzle-orm";
import { agentTable } from "./schema/agent";
import { serverTable } from "./schema/server";
import { getDb } from "./types";

export async function installRLSFunctions(adapter: IDatabaseAdapter): Promise<void> {
  const db = getDb(adapter);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS servers (
      id UUID PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
    )
  `);

  await db.execute(sql`
    CREATE OR REPLACE FUNCTION current_server_id() RETURNS UUID AS $$
    DECLARE
      app_name TEXT;
    BEGIN
      app_name := NULLIF(current_setting('application_name', TRUE), '');

      BEGIN
        RETURN app_name::UUID;
      EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
      END;
    END;
    $$ LANGUAGE plpgsql STABLE;
  `);

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

      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE information_schema.columns.table_schema = schema_name
          AND information_schema.columns.table_name = add_server_isolation.table_name
          AND information_schema.columns.column_name = 'server_id'
      ) INTO column_exists;

      IF NOT column_exists THEN
        EXECUTE format('ALTER TABLE %I.%I ADD COLUMN server_id UUID DEFAULT current_server_id()', schema_name, table_name);
        EXECUTE format('UPDATE %I.%I SET server_id = current_server_id() WHERE server_id IS NULL', schema_name, table_name);
      ELSE
        EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN server_id SET DEFAULT current_server_id()', schema_name, table_name);
        EXECUTE format('SELECT COUNT(*) FROM %I.%I WHERE server_id IS NULL', schema_name, table_name) INTO orphaned_count;

        IF orphaned_count > 0 THEN
          RAISE NOTICE 'Backfilling % rows with NULL server_id in %.%', orphaned_count, schema_name, table_name;
          EXECUTE format('UPDATE %I.%I SET server_id = current_server_id() WHERE server_id IS NULL', schema_name, table_name);
        END IF;
      END IF;

      EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%I_server_id ON %I.%I(server_id)', table_name, schema_name, table_name);
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', schema_name, table_name);
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', schema_name, table_name);
      EXECUTE format('DROP POLICY IF EXISTS server_isolation_policy ON %I.%I', schema_name, table_name);
      EXECUTE format('
        CREATE POLICY server_isolation_policy ON %I.%I
        USING (server_id = current_server_id())
        WITH CHECK (server_id = current_server_id())
      ', schema_name, table_name);
    END;
    $$ LANGUAGE plpgsql;
  `);

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
            '__drizzle_migrations'
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

  logger.info({ src: "plugin:sql" }, "RLS PostgreSQL functions installed");
  await installEntityRLS(adapter);
}

export async function getOrCreateRlsServer(
  adapter: IDatabaseAdapter,
  serverId: string
): Promise<string> {
  const db = getDb(adapter);

  // Use Drizzle's insert with onConflictDoNothing
  await db
    .insert(serverTable)
    .values({
      id: serverId,
    })
    .onConflictDoNothing();

  logger.info({ src: "plugin:sql", serverId: serverId.slice(0, 8) }, "RLS server registered");
  return serverId;
}

export async function setServerContext(adapter: IDatabaseAdapter, serverId: string): Promise<void> {
  if (!validateUuid(serverId)) {
    throw new Error(`Invalid server ID format: ${serverId}. Must be a valid UUID.`);
  }

  const db = getDb(adapter);
  const servers = await db.select().from(serverTable).where(eq(serverTable.id, serverId));

  if (servers.length === 0) {
    throw new Error(`Server ${serverId} does not exist`);
  }

  logger.info({ src: "plugin:sql", serverId: serverId.slice(0, 8) }, "RLS context configured");
}

export async function assignAgentToServer(
  adapter: IDatabaseAdapter,
  agentId: string,
  serverId: string
): Promise<void> {
  if (!agentId || !serverId) {
    logger.warn(
      `[Data Isolation] Cannot assign agent to server: invalid agentId (${agentId}) or serverId (${serverId})`
    );
    return;
  }

  const db = getDb(adapter);

  // Check if agent exists using Drizzle
  const agents = await db.select().from(agentTable).where(eq(agentTable.id, agentId));

  if (agents.length > 0) {
    const agent = agents[0];
    const currentServerId = agent.server_id;

    if (currentServerId === serverId) {
      logger.debug(
        { src: "plugin:sql", agentName: agent.name },
        "Agent already assigned to correct server"
      );
    } else {
      // Update agent server using Drizzle
      await db.update(agentTable).set({ server_id: serverId }).where(eq(agentTable.id, agentId));

      if (currentServerId === null) {
        logger.info({ src: "plugin:sql", agentName: agent.name }, "Agent assigned to server");
      } else {
        logger.warn({ src: "plugin:sql", agentName: agent.name }, "Agent server changed");
      }
    }
  } else {
    logger.debug({ src: "plugin:sql", agentId }, "Agent does not exist yet");
  }
}

/**
 * Apply RLS to all tables by calling PostgreSQL function
 */
export async function applyRLSToNewTables(adapter: IDatabaseAdapter): Promise<void> {
  const db = getDb(adapter);

  try {
    await db.execute(sql`SELECT apply_rls_to_all_tables()`);
    logger.info({ src: "plugin:sql" }, "RLS applied to all tables");
  } catch (error) {
    logger.warn({ src: "plugin:sql", error: String(error) }, "Failed to apply RLS to some tables");
  }
}

export async function uninstallRLS(adapter: IDatabaseAdapter): Promise<void> {
  const db = getDb(adapter);

  try {
    const checkResult = await db.execute(sql`
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE schemaname = 'public' AND tablename = 'servers'
      ) as rls_enabled
    `);

    const rlsEnabled = checkResult.rows?.[0]?.rls_enabled;

    if (!rlsEnabled) {
      logger.debug({ src: "plugin:sql" }, "RLS not installed, skipping cleanup");
      return;
    }

    logger.info(
      { src: "plugin:sql" },
      "Disabling RLS globally (keeping server_id columns for schema compatibility)..."
    );

    try {
      await uninstallEntityRLS(adapter);
    } catch (_entityRlsError) {
      logger.debug(
        { src: "plugin:sql" },
        "Entity RLS cleanup skipped (not installed or already cleaned)"
      );
    }

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
        await db.execute(sql`SELECT _temp_disable_rls_on_table(${schemaName}, ${tableName})`);
        logger.debug({ src: "plugin:sql", schemaName, tableName }, "Disabled RLS on table");
      } catch (error) {
        logger.warn(
          { src: "plugin:sql", schemaName, tableName, error: String(error) },
          "Failed to disable RLS on table"
        );
      }
    }

    await db.execute(sql`DROP FUNCTION IF EXISTS _temp_disable_rls_on_table(text, text)`);

    logger.info(
      { src: "plugin:sql" },
      "Keeping server_id values intact (prevents data theft on re-enable)"
    );

    logger.info({ src: "plugin:sql" }, "Clearing servers table...");
    await db.execute(sql`TRUNCATE TABLE servers`);

    await db.execute(sql`DROP FUNCTION IF EXISTS apply_rls_to_all_tables() CASCADE`);
    await db.execute(sql`DROP FUNCTION IF EXISTS add_server_isolation(text, text) CASCADE`);
    await db.execute(sql`DROP FUNCTION IF EXISTS current_server_id() CASCADE`);
    logger.info({ src: "plugin:sql" }, "Dropped all RLS functions");

    logger.info({ src: "plugin:sql" }, "RLS disabled successfully (server_id columns preserved)");
  } catch (error) {
    logger.error({ src: "plugin:sql", error: String(error) }, "Failed to disable RLS");
    throw error;
  }
}

export async function installEntityRLS(adapter: IDatabaseAdapter): Promise<void> {
  const db = getDb(adapter);

  logger.info("[Entity RLS] Installing entity RLS functions and policies...");

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

  logger.info("[Entity RLS] Created current_entity_id() function");

  // 2. Create add_entity_isolation() function - applies entity RLS to a single table
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION add_entity_isolation(
      schema_name text,
      table_name text,
      require_entity boolean DEFAULT false
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
          AND information_schema.columns.column_name = 'room_id'
      ) INTO has_room_id;

      IF NOT (has_entity_id OR has_author_id OR has_room_id) THEN
        RAISE NOTICE '[Entity RLS] Skipping %.%: no entity columns found', schema_name, table_name;
        RETURN;
      END IF;

      IF table_name = 'participants' AND has_entity_id THEN
        entity_column_name := 'entity_id';
        room_column_name := NULL;
      ELSIF has_room_id THEN
        room_column_name := 'room_id';
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

      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', schema_name, table_name);
      EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', schema_name, table_name);
      EXECUTE format('DROP POLICY IF EXISTS entity_isolation_policy ON %I.%I', schema_name, table_name);

      IF room_column_name IS NOT NULL THEN
        IF require_entity THEN
          EXECUTE format('
            CREATE POLICY entity_isolation_policy ON %I.%I
            AS RESTRICTIVE
            USING (
              current_entity_id() IS NOT NULL
              AND %I IN (
                SELECT room_id
                FROM participants
                WHERE entity_id = current_entity_id()
              )
            )
            WITH CHECK (
              current_entity_id() IS NOT NULL
              AND %I IN (
                SELECT room_id
                FROM participants
                WHERE entity_id = current_entity_id()
              )
            )
          ', schema_name, table_name, room_column_name, room_column_name);
          RAISE NOTICE '[Entity RLS] Applied STRICT RESTRICTIVE to %.% (via % → participants.room_id, entity REQUIRED)', schema_name, table_name, room_column_name;
        ELSE
          EXECUTE format('
            CREATE POLICY entity_isolation_policy ON %I.%I
            AS RESTRICTIVE
            USING (
              current_entity_id() IS NULL
              OR %I IN (
                SELECT room_id
                FROM participants
                WHERE entity_id = current_entity_id()
              )
            )
            WITH CHECK (
              current_entity_id() IS NULL
              OR %I IN (
                SELECT room_id
                FROM participants
                WHERE entity_id = current_entity_id()
              )
            )
          ', schema_name, table_name, room_column_name, room_column_name);
          RAISE NOTICE '[Entity RLS] Applied PERMISSIVE RESTRICTIVE to %.% (via % → participants.room_id, NULL allowed)', schema_name, table_name, room_column_name;
        END IF;

      ELSIF entity_column_name IS NOT NULL THEN
        IF require_entity THEN
          EXECUTE format('
            CREATE POLICY entity_isolation_policy ON %I.%I
            AS RESTRICTIVE
            USING (
              current_entity_id() IS NOT NULL
              AND %I = current_entity_id()
            )
            WITH CHECK (
              current_entity_id() IS NOT NULL
              AND %I = current_entity_id()
            )
          ', schema_name, table_name, entity_column_name, entity_column_name);
          RAISE NOTICE '[Entity RLS] Applied STRICT RESTRICTIVE to %.% (direct column: %, entity REQUIRED)', schema_name, table_name, entity_column_name;
        ELSE
          -- PERMISSIVE MODE: NULL entity_id allows system/admin access
          EXECUTE format('
            CREATE POLICY entity_isolation_policy ON %I.%I
            AS RESTRICTIVE
            USING (
              current_entity_id() IS NULL
              OR %I = current_entity_id()
            )
            WITH CHECK (
              current_entity_id() IS NULL
              OR %I = current_entity_id()
            )
          ', schema_name, table_name, entity_column_name, entity_column_name);
          RAISE NOTICE '[Entity RLS] Applied PERMISSIVE RESTRICTIVE to %.% (direct column: %, NULL allowed)', schema_name, table_name, entity_column_name;
        END IF;
      END IF;

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

  logger.info("[Entity RLS] Created add_entity_isolation() function");

  await db.execute(sql`
    CREATE OR REPLACE FUNCTION apply_entity_rls_to_all_tables() RETURNS void AS $$
    DECLARE
      tbl record;
      require_entity_for_table boolean;
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
            '__drizzle_migrations'  -- Migration tracking
          )
      LOOP
        BEGIN
          -- Apply STRICT mode (require_entity=true) to sensitive user-facing tables
          -- These tables MUST have entity context set to access data
          -- STRICT tables: memories, logs, components, tasks (user data requiring isolation)
          -- NOTE: Excluded tables:
          --   - 'participants': Adding participants is a privileged operation during initialization
          IF tbl.tablename IN ('memories', 'logs', 'components', 'tasks') THEN
            require_entity_for_table := true;
          ELSE
            require_entity_for_table := false;
          END IF;

          PERFORM add_entity_isolation(tbl.schemaname, tbl.tablename, require_entity_for_table);
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING '[Entity RLS] Failed to apply to %.%: %', tbl.schemaname, tbl.tablename, SQLERRM;
        END;
      END LOOP;
    END;
    $$ LANGUAGE plpgsql;
  `);

  logger.info("[Entity RLS] Created apply_entity_rls_to_all_tables() function");

  logger.info("[Entity RLS] Entity RLS functions installed successfully");
}

export async function applyEntityRLSToAllTables(adapter: IDatabaseAdapter): Promise<void> {
  const db = getDb(adapter);

  try {
    await db.execute(sql`SELECT apply_entity_rls_to_all_tables()`);
    logger.info("[Entity RLS] Applied entity RLS to all eligible tables");
  } catch (error) {
    logger.warn("[Entity RLS] Failed to apply entity RLS to some tables:", String(error));
  }
}

export async function uninstallEntityRLS(adapter: IDatabaseAdapter): Promise<void> {
  const db = getDb(adapter);

  logger.info("[Entity RLS] Removing entity RLS policies and functions...");

  try {
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
        await db.execute(
          sql.raw(`DROP POLICY IF EXISTS entity_isolation_policy ON "${schemaName}"."${tableName}"`)
        );
        logger.debug(
          `[Entity RLS] Dropped entity_isolation_policy from ${schemaName}.${tableName}`
        );
      } catch (_error) {
        logger.debug(`[Entity RLS] No entity policy on ${schemaName}.${tableName}`);
      }
    }

    await db.execute(sql`DROP FUNCTION IF EXISTS apply_entity_rls_to_all_tables() CASCADE`);
    await db.execute(sql`DROP FUNCTION IF EXISTS add_entity_isolation(text, text) CASCADE`);
    await db.execute(sql`DROP FUNCTION IF EXISTS current_entity_id() CASCADE`);

    logger.info("[Entity RLS] Entity RLS functions and policies removed successfully");
  } catch (error) {
    logger.error("[Entity RLS] Failed to remove entity RLS:", String(error));
    throw error;
  }
}
