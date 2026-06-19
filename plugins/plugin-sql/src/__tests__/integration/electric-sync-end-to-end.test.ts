import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { v4 } from "uuid";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import { PGliteClientManager } from "../../pglite/manager";
import * as schema from "../../schema";
import type { DrizzleDatabase } from "../../types";

/**
 * End-to-end Electric Sync integration test.
 *
 * Requires a local Postgres + Electric stack. Start it with:
 *   docker compose -f plugins/plugin-sql/docker-compose.electric-test.yml up -d
 *
 * Tests the full data flow:
 *   Postgres (source) → Electric (shape server) → PGlite (syncShapesToTables)
 *
 * Verifies:
 *   1. Data inserted in Postgres flows to PGlite via Electric sync.
 *   2. Per-agent isolation: agentA's PGlite receives only agentA's rows.
 *   3. Sync status transitions from "syncing" → "synced".
 *
 * All tests skip gracefully when the Electric containers are not running.
 */

const ELECTRIC_HEALTH_URL = "http://localhost:3000/api/health";
const ELECTRIC_SYNC_URL = "http://localhost:3000";
const POSTGRES_URL = "postgresql://postgres:postgres@localhost:5433/electric_test";

let containersAvailable = false;
let pgModule: typeof import("pg") | null = null;

// ------------------------------------------------------------------
// Probe whether the Docker containers are reachable.
// ------------------------------------------------------------------
beforeAll(async () => {
  try {
    // Try to reach Electric's health endpoint.
    const res = await fetch(ELECTRIC_HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      throw new Error(`Electric health check returned ${res.status}`);
    }
    // Dynamically import pg so tests that don't use it don't fail on missing dep.
    try {
      pgModule = await import("pg");
    } catch {
      console.warn(
        "[e2e-sync] Electric containers are reachable but 'pg' module is not installed. " +
          "Install it with: bun add pg"
      );
      return;
    }
    containersAvailable = true;
  } catch {
    console.warn(
      "[e2e-sync] Electric containers not reachable at localhost:3000. " +
        "Start them with: docker compose -f plugins/plugin-sql/docker-compose.electric-test.yml up -d"
    );
  }
}, 10_000);

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Connect to Postgres and run raw SQL. */
async function pgExec(query: string): Promise<void> {
  if (!pgModule) throw new Error("pg module not loaded");
  const client = new pgModule.Client({ connectionString: POSTGRES_URL });
  try {
    await client.connect();
    await client.query(query);
  } finally {
    await client.end();
  }
}

/**
 * Create the plugin-sql schema tables in Postgres so Electric can
 * discover them and serve shapes for them.
 */
async function createPostgresSchema(): Promise<void> {
  // Drop existing tables for a clean slate.
  await pgExec(`
    DO $$ DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `);

  // Create ALL tables that the sync config expects (manager.ts tables array).
  // Electric's syncShapesToTables is all-or-nothing — if any table is missing
  // from Postgres, that shape errors and onInitialSync never fires.
  await pgExec(`
    CREATE TABLE agents (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      bio JSONB DEFAULT '[]'::jsonb,
      topics JSONB DEFAULT '[]'::jsonb,
      adjectives JSONB DEFAULT '[]'::jsonb,
      knowledge JSONB DEFAULT '[]'::jsonb,
      plugins JSONB DEFAULT '[]'::jsonb,
      settings JSONB DEFAULT '{}'::jsonb
    );

    CREATE TABLE entities (
      id UUID PRIMARY KEY,
      agent_id UUID NOT NULL,
      name TEXT,
      metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE worlds (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL,
      name TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE rooms (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
      name TEXT,
      source TEXT NOT NULL,
      type TEXT NOT NULL,
      message_server_id UUID,
      world_id UUID,
      metadata JSONB,
      channel_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE participants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL,
      room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
      user_id UUID,
      role TEXT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE memories (
      id UUID PRIMARY KEY,
      type TEXT NOT NULL,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      room_id UUID REFERENCES rooms(id) ON DELETE CASCADE,
      entity_id UUID,
      world_id UUID,
      content JSONB NOT NULL,
      "unique" BOOLEAN DEFAULT true NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE relationships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id UUID NOT NULL,
      source_entity_id UUID,
      target_entity_id UUID,
      metadata JSONB DEFAULT '{}'::jsonb NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      description TEXT,
      room_id UUID,
      world_id UUID,
      entity_id UUID,
      agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      tags TEXT[] DEFAULT '{}'::text[],
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE user_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL,
      organization_id UUID NOT NULL,
      session_token TEXT NOT NULL UNIQUE,
      credits_used NUMERIC(10,2) DEFAULT 0.00 NOT NULL,
      requests_made INTEGER DEFAULT 0 NOT NULL,
      tokens_consumed BIGINT DEFAULT 0 NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ,
      ip_address TEXT,
      user_agent TEXT,
      device_info JSONB DEFAULT '{}'::jsonb NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// ------------------------------------------------------------------
// Test suite
// ------------------------------------------------------------------
describe("Electric Sync end-to-end", () => {
  const cleanups: Array<{ dir: string; manager?: PGliteClientManager }> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) {
      if (c.manager) {
        try {
          await c.manager.close();
        } catch {}
      }
      try {
        fs.rmSync(c.dir, { recursive: true, force: true });
      } catch {}
    }
  });

  // ------------------------------------------------------------------
  // 1. Data flows: Postgres → Electric → PGlite
  // ------------------------------------------------------------------
  it("synced data from Postgres flows to PGlite via Electric", async () => {
    if (!containersAvailable) return;

    // 1. Create schema and insert test data in Postgres.
    await createPostgresSchema();

    const agentId = v4();
    const roomId = v4();
    const memoryId = v4();
    const now = Date.now() / 1000.0;

    await pgExec(`
      INSERT INTO agents (id, name, created_at, updated_at)
      VALUES ('${agentId}', 'e2e-agent', to_timestamp(${now}), to_timestamp(${now}));

      INSERT INTO rooms (id, agent_id, name, source, type, created_at)
      VALUES ('${roomId}', '${agentId}', 'e2e-room', 'test', 'GROUP', to_timestamp(${now}));

      INSERT INTO memories (id, type, agent_id, room_id, content, created_at)
      VALUES ('${memoryId}', 'test', '${agentId}', '${roomId}', '{"text":"hello from pg"}'::jsonb, to_timestamp(${now}));
    `);

    // 2. Create PGlite with Electric sync and run migrations locally.
    const dir = createTempDir("eliza-e2e-sync-");
    const manager = new PGliteClientManager({
      dataDir: dir,
      syncUrl: ELECTRIC_SYNC_URL,
      agentId,
    });
    cleanups.push({ dir, manager });
    await manager.initialize();

    const client = manager.getConnection();
    const { drizzle } = await import("drizzle-orm/pglite");
    const db = drizzle(client) as unknown as DrizzleDatabase;

    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
    ]);
    await migrationService.runAllPluginMigrations();

    // 3. Trigger sync.
    await manager.ensureSync();

    // 4. Poll for sync completion (max 15s).
    const deadline = Date.now() + 15_000;
    let synced = false;
    while (Date.now() < deadline) {
      const status = manager.getSyncStatus();
      if (status.status === "synced" || status.synced.length >= 3) {
        synced = true;
        break;
      }
      if (status.status === "error") {
        throw new Error(`Sync errored: ${status.error}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(synced).toBe(true);

    // 5. Verify synced data in PGlite matches Postgres.
    const agentRows = await db.execute(
      sql.raw(`SELECT id, name FROM agents WHERE id = '${agentId}'`)
    );
    const agents = agentRows.rows as Array<{ id: string; name: string }>;
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe("e2e-agent");

    const roomRows = await db.execute(
      sql.raw(`SELECT id, name FROM rooms WHERE agent_id = '${agentId}'`)
    );
    const rooms = roomRows.rows as Array<{ id: string; name: string }>;
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.name).toBe("e2e-room");

    const memoryRows = await db.execute(
      sql.raw(`SELECT id, content FROM memories WHERE agent_id = '${agentId}'`)
    );
    const memories = memoryRows.rows as Array<{ id: string; content: unknown }>;
    expect(memories).toHaveLength(1);
  }, 30_000);

  // ------------------------------------------------------------------
  // 2. Per-agent isolation: agentA's PGlite only sees agentA's data
  // ------------------------------------------------------------------
  it("per-agent isolation: only the synced agent's rows appear in PGlite", async () => {
    if (!containersAvailable) return;

    await createPostgresSchema();

    const agentA = v4();
    const agentB = v4();
    const roomA = v4();
    const roomB = v4();
    const memoryA = v4();
    const memoryB = v4();
    const now = Date.now() / 1000.0;

    // Seed data for two agents in Postgres.
    await pgExec(`
      INSERT INTO agents (id, name, created_at, updated_at)
      VALUES
        ('${agentA}', 'agent-a', to_timestamp(${now}), to_timestamp(${now})),
        ('${agentB}', 'agent-b', to_timestamp(${now}), to_timestamp(${now}));

      INSERT INTO rooms (id, agent_id, name, source, type, created_at)
      VALUES
        ('${roomA}', '${agentA}', 'room-a', 'test', 'GROUP', to_timestamp(${now})),
        ('${roomB}', '${agentB}', 'room-b', 'test', 'GROUP', to_timestamp(${now}));

      INSERT INTO memories (id, type, agent_id, room_id, content, created_at)
      VALUES
        ('${memoryA}', 'test', '${agentA}', '${roomA}', '{"text":"a"}'::jsonb, to_timestamp(${now})),
        ('${memoryB}', 'test', '${agentB}', '${roomB}', '{"text":"b"}'::jsonb, to_timestamp(${now}));
    `);

    // Sync PGlite as agentA — should only receive agentA's rows.
    const dir = createTempDir("eliza-e2e-iso-");
    const manager = new PGliteClientManager({
      dataDir: dir,
      syncUrl: ELECTRIC_SYNC_URL,
      agentId: agentA,
    });
    cleanups.push({ dir, manager });
    await manager.initialize();

    const client = manager.getConnection();
    const { drizzle } = await import("drizzle-orm/pglite");
    const db = drizzle(client) as unknown as DrizzleDatabase;

    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
    ]);
    await migrationService.runAllPluginMigrations();

    await manager.ensureSync();

    // Poll for sync completion.
    const deadline = Date.now() + 15_000;
    let synced = false;
    while (Date.now() < deadline) {
      const status = manager.getSyncStatus();
      if (status.status === "synced") {
        synced = true;
        break;
      }
      if (status.status === "error") {
        throw new Error(`Sync errored: ${status.error}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(synced).toBe(true);

    // agentA's data should be present.
    const agentARows = await db.execute(
      sql.raw(`SELECT id, name FROM agents WHERE id = '${agentA}'`)
    );
    expect((agentARows.rows as Array<{ name: string }>)[0]?.name).toBe("agent-a");

    const roomARows = await db.execute(
      sql.raw(`SELECT id, name FROM rooms WHERE agent_id = '${agentA}'`)
    );
    expect((roomARows.rows as Array<{ name: string }>)[0]?.name).toBe("room-a");

    const memoryARows = await db.execute(
      sql.raw(`SELECT id FROM memories WHERE agent_id = '${agentA}'`)
    );
    expect(memoryARows.rows).toHaveLength(1);

    // agentB's data should NOT be present (filtered by agent_id = $1).
    const agentBRows = await db.execute(sql.raw(`SELECT id FROM agents WHERE id = '${agentB}'`));
    expect(agentBRows.rows).toHaveLength(0);

    const roomBRows = await db.execute(
      sql.raw(`SELECT id FROM rooms WHERE agent_id = '${agentB}'`)
    );
    expect(roomBRows.rows).toHaveLength(0);

    const memoryBRows = await db.execute(
      sql.raw(`SELECT id FROM memories WHERE agent_id = '${agentB}'`)
    );
    expect(memoryBRows.rows).toHaveLength(0);
  }, 30_000);

  // ------------------------------------------------------------------
  // 3. Sync status transitions: disabled → syncing → synced
  // ------------------------------------------------------------------
  it("sync status transitions from disabled through syncing to synced", async () => {
    if (!containersAvailable) return;

    await createPostgresSchema();

    const agentId = v4();
    const now = Date.now() / 1000.0;

    await pgExec(`
      INSERT INTO agents (id, name, created_at, updated_at)
      VALUES ('${agentId}', 'status-agent', to_timestamp(${now}), to_timestamp(${now}));
    `);

    const dir = createTempDir("eliza-e2e-status-");
    const manager = new PGliteClientManager({
      dataDir: dir,
      syncUrl: ELECTRIC_SYNC_URL,
      agentId,
    });
    cleanups.push({ dir, manager });

    // Before initialize, status is disabled.
    expect(manager.getSyncStatus().status).toBe("disabled");

    await manager.initialize();

    const client = manager.getConnection();
    const { drizzle } = await import("drizzle-orm/pglite");
    const db = drizzle(client) as unknown as DrizzleDatabase;

    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL plugin", schema },
    ]);
    await migrationService.runAllPluginMigrations();

    // Trigger sync — status should transition. Poll until outcome.
    await manager.ensureSync();

    const deadline = Date.now() + 15_000;
    let finalStatus = "";
    while (Date.now() < deadline) {
      const { status, error } = manager.getSyncStatus();
      finalStatus = status;
      if (status === "synced") break;
      if (status === "error") {
        throw new Error(`Sync errored: ${error}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(finalStatus).toBe("synced");
  }, 30_000);
}, 90_000);
