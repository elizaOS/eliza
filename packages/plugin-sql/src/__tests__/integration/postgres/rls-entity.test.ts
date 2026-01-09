import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { stringToUuid, type IDatabaseAdapter, type UUID } from '@elizaos/core';
import { DatabaseMigrationService } from '../../../migration-service';
import { plugin as sqlPlugin } from '../../../index';
import { installRLSFunctions, applyRLSToNewTables, applyEntityRLSToAllTables } from '../../../rls';
import { PostgresConnectionManager } from '../../../pg/manager';

/**
 * PostgreSQL RLS Entity Integration Tests
 *
 * These tests require a real PostgreSQL database with RLS enabled.
 * Run with: docker-compose up -d postgres
 *
 * Tests verify:
 * - Entity-level isolation (user privacy)
 * - Participant-based access control (room membership)
 * - Entity RLS works with Server RLS (double isolation)
 * - withEntityContext() correctly sets entity context (regression test for sql.raw fix)
 *
 * This test is the FIRST in BATCH_RLS and is responsible for:
 * 1. Running migrations to create the schema
 * 2. Installing RLS functions and policies
 *
 * IMPORTANT: Uses PostgresConnectionManager.withEntityContext() to test the actual
 * production code path. This ensures the Drizzle sql.raw() fix is tested (no $1 error).
 */

// Skip these tests if POSTGRES_URL is not set (e.g., in CI without PostgreSQL)
describe.skipIf(!process.env.POSTGRES_URL)('PostgreSQL RLS Entity Integration', () => {
  let setupClient: Client; // Setup client for migrations (eliza_test user)
  let superuserClient: Client; // Superuser client for data setup (bypasses RLS)
  let manager: PostgresConnectionManager; // Production code path for RLS tests

  const POSTGRES_URL =
    process.env.POSTGRES_URL || 'postgresql://eliza_test:test123@localhost:5432/eliza_test';
  // Use ELIZA_SERVER_ID if set (CI mode with ENABLE_DATA_ISOLATION=true)
  // Otherwise generate a random UUID for local testing
  const serverId = process.env.ELIZA_SERVER_ID
    ? stringToUuid(process.env.ELIZA_SERVER_ID)
    : uuidv4();
  const aliceId = uuidv4();
  const bobId = uuidv4();
  const charlieId = uuidv4();
  const room1Id = uuidv4();
  const room2Id = uuidv4();
  const agentId = uuidv4();

  beforeAll(async () => {
    // Setup client with server context (for migrations)
    setupClient = new Client({
      connectionString: POSTGRES_URL,
      application_name: serverId,
    });
    await setupClient.connect();

    // Superuser connection for data setup (bypasses RLS)
    // This is needed because RLS policies block inserts without proper entity context
    const superuserUrl = new URL(POSTGRES_URL);
    superuserUrl.username = 'postgres';
    superuserUrl.password = 'postgres';
    superuserClient = new Client({
      connectionString: superuserUrl.toString(),
      application_name: serverId,
    });

    // Clean up from previous tests - drop all tables and schemas for fresh start
    try {
      await superuserClient.connect();
      await superuserClient.query(`DROP SCHEMA IF EXISTS migrations CASCADE`);
      await superuserClient.query(`
        DO $$ DECLARE
          r RECORD;
        BEGIN
          FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
            EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
          END LOOP;
        END $$;
      `);
      console.log('[RLS Test] Cleanup complete using superuser');
    } catch (err) {
      console.log('[RLS Test] Superuser cleanup failed:', err instanceof Error ? err.message : String(err));
      throw new Error('RLS tests require superuser access for cleanup and data setup');
    }

    // Initialize schema with migrations
    const db = drizzle(setupClient);
    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrationService.runAllPluginMigrations();
    console.log('[RLS Test] Schema initialized via migrations');

    // Install RLS functions and apply to all tables
    // Skip if ENABLE_DATA_ISOLATION is already set (CI mode) - migrations already installed them
    const mockAdapter = { db } as IDatabaseAdapter;
    if (process.env.ENABLE_DATA_ISOLATION !== 'true') {
      await installRLSFunctions(mockAdapter);
      await applyRLSToNewTables(mockAdapter);
      await applyEntityRLSToAllTables(mockAdapter);
      console.log('[RLS Test] RLS functions installed and applied');
    } else {
      // In CI with ENABLE_DATA_ISOLATION=true, migrations already installed RLS.
      // We still need to apply entity RLS to ensure participant-based isolation is set up.
      await applyEntityRLSToAllTables(mockAdapter);
      console.log('[RLS Test] RLS already installed by migrations, applied entity RLS');
    }

    // Grant permissions on newly created tables to eliza_test
    // (in case the test is run by a different user who owns the tables)
    try {
      await setupClient.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO eliza_test`);
      await setupClient.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO eliza_test`);
    } catch (err) {
      // Ignore if already granted or permission denied (we're already eliza_test)
      console.log('[RLS Test] Permission grant skipped (may already be granted)');
    }

    // Create PostgresConnectionManager for test assertions
    // This tests the actual production code path (withEntityContext + sql.raw fix)
    manager = new PostgresConnectionManager(POSTGRES_URL, serverId);

    // Enable data isolation for these tests (required for withEntityContext to set entity context)
    process.env.ENABLE_DATA_ISOLATION = 'true';

    // Setup test data using superuser (bypasses RLS for initial data creation)
    // servers table has no RLS, so any connection can insert
    await superuserClient.query(
      `INSERT INTO servers (id, created_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [serverId]
    );

    // Create agent (explicitly set server_id for RLS)
    await superuserClient.query(
      `INSERT INTO agents (id, name, username, server_id, created_at, updated_at)
       VALUES ($1, 'Test Agent RLS', $2, $3, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [agentId, `rls_test_agent_${serverId.substring(0, 8)}`, serverId]
    );

    // Create entities
    try {
      const result = await superuserClient.query(
        `INSERT INTO entities (id, agent_id, names, metadata, server_id, created_at)
         VALUES
           ($1, $4, ARRAY['Alice'], '{}'::jsonb, $5, NOW()),
           ($2, $4, ARRAY['Bob'], '{}'::jsonb, $5, NOW()),
           ($3, $4, ARRAY['Charlie'], '{}'::jsonb, $5, NOW())
         ON CONFLICT (id) DO UPDATE SET names = EXCLUDED.names
         RETURNING id`,
        [aliceId, bobId, charlieId, agentId, serverId]
      );
      console.log('[RLS Test] Entities created:', result.rows.length);
    } catch (err) {
      console.error(
        '[RLS Test] Failed to create entities:',
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }

    // Create rooms
    await superuserClient.query(
      `INSERT INTO rooms (id, agent_id, source, type, server_id, created_at)
       VALUES
         ($1, $3, 'test', 'DM', $4, NOW()),
         ($2, $3, 'test', 'GROUP', $4, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [room1Id, room2Id, agentId, serverId]
    );

    // Create participants
    // Room1: Alice + Bob
    // Room2: Bob + Charlie
    try {
      const participantResult = await superuserClient.query(
        `INSERT INTO participants (id, entity_id, room_id, agent_id, server_id, created_at)
         VALUES
           (gen_random_uuid(), $1, $2, $4, $7, NOW()),
           (gen_random_uuid(), $3, $2, $4, $7, NOW()),
           (gen_random_uuid(), $3, $5, $4, $7, NOW()),
           (gen_random_uuid(), $6, $5, $4, $7, NOW())
         ON CONFLICT DO NOTHING
         RETURNING id, entity_id`,
        [aliceId, room1Id, bobId, agentId, room2Id, charlieId, serverId]
      );
      console.log(
        '[RLS Test] Participants created:',
        participantResult.rows.length,
        participantResult.rows.map((r: { entity_id?: string }) => ({ e: r.entity_id?.substring(0, 8) }))
      );
    } catch (err) {
      console.error(
        '[RLS Test] Failed to create participants:',
        err instanceof Error ? err.message : String(err)
      );
      console.log('UUIDs:', { aliceId, bobId, charlieId, room1Id, room2Id, agentId });
      throw err;
    }

    // Create memories (with server_id explicitly set)
    // Memory in room1 (accessible to Alice and Bob)
    await superuserClient.query(
      `INSERT INTO memories (id, agent_id, room_id, content, type, server_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, '{"text": "Message in room1"}', 'message', $3, NOW())`,
      [agentId, room1Id, serverId]
    );

    // Memory in room2 (accessible to Bob and Charlie)
    await superuserClient.query(
      `INSERT INTO memories (id, agent_id, room_id, content, type, server_id, created_at)
       VALUES (gen_random_uuid(), $1, $2, '{"text": "Message in room2"}', 'message', $3, NOW())`,
      [agentId, room2Id, serverId]
    );

    console.log('[RLS Test] Test data setup complete');
  });

  afterAll(async () => {
    // Cleanup using superuser (bypasses RLS)
    try {
      await superuserClient.query(`DELETE FROM memories WHERE room_id IN ($1, $2)`, [room1Id, room2Id]);
      await superuserClient.query(`DELETE FROM participants WHERE room_id IN ($1, $2)`, [
        room1Id,
        room2Id,
      ]);
      await superuserClient.query(`DELETE FROM rooms WHERE id IN ($1, $2)`, [room1Id, room2Id]);
      await superuserClient.query(`DELETE FROM entities WHERE id IN ($1, $2, $3)`, [
        aliceId,
        bobId,
        charlieId,
      ]);
      await superuserClient.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
      await superuserClient.query(`DELETE FROM servers WHERE id = $1`, [serverId]);
    } catch (err) {
      console.warn('[RLS Test] Cleanup error:', err);
    }

    await setupClient.end();
    await superuserClient.end();
    await manager.close();
  });

  it('should block access without entity context', async () => {
    // Without entity context, user should see 0 memories (STRICT mode)
    // Use withEntityContext with null to test no entity context
    const result = await manager.withEntityContext(null, async (tx) => {
      return await tx.execute(sql`SELECT COUNT(*) as count FROM memories`);
    });

    expect(parseInt(String(result.rows[0].count))).toBe(0);
  });

  it('should allow Alice to see room1 memories (tests withEntityContext + sql.raw fix)', async () => {
    // This test verifies the production code path works:
    // withEntityContext() -> sql.raw(`SET LOCAL app.entity_id = '${entityId}'`)
    // Before the fix, this would fail with "syntax error at or near $1"
    const result = await manager.withEntityContext(aliceId as UUID, async (tx) => {
      return await tx.execute(sql`SELECT id, room_id, content FROM memories`);
    });

    // Alice is in room1, so should see 1 memory
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].room_id).toBe(room1Id);
    expect((result.rows[0].content as { text: string }).text).toContain('room1');
  });

  it('should allow Bob to see BOTH room1 and room2 memories', async () => {
    const result = await manager.withEntityContext(bobId as UUID, async (tx) => {
      return await tx.execute(sql`SELECT id, room_id, content FROM memories ORDER BY room_id`);
    });

    // Bob is in both rooms, so should see 2 memories
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r: { room_id: string }) => r.room_id)).toContain(room1Id);
    expect(result.rows.map((r: { room_id: string }) => r.room_id)).toContain(room2Id);
  });

  it('should allow Charlie to see ONLY room2 memories', async () => {
    const result = await manager.withEntityContext(charlieId as UUID, async (tx) => {
      return await tx.execute(sql`SELECT id, room_id, content FROM memories`);
    });

    // Charlie is only in room2
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].room_id).toBe(room2Id);
    expect((result.rows[0].content as { text: string }).text).toContain('room2');
  });

  it('should block non-participant from seeing any memories', async () => {
    const nonParticipantId = uuidv4();

    const result = await manager.withEntityContext(nonParticipantId as UUID, async (tx) => {
      return await tx.execute(sql`SELECT COUNT(*) as count FROM memories`);
    });

    // Non-participant should see 0
    expect(parseInt(String(result.rows[0].count))).toBe(0);
  });

  it('should have entity_isolation_policy on key tables', async () => {
    // pg_policies is a system catalog, any user can query it
    const result = await manager.withEntityContext(null, async (tx) => {
      return await tx.execute(sql`
        SELECT DISTINCT tablename
        FROM pg_policies
        WHERE policyname = 'entity_isolation_policy'
          AND tablename IN ('memories', 'participants', 'components', 'logs', 'tasks')
      `);
    });

    expect(result.rows.length).toBeGreaterThanOrEqual(3);
  });

  it('should use current_entity_id() function correctly via withEntityContext', async () => {
    const result = await manager.withEntityContext(aliceId as UUID, async (tx) => {
      return await tx.execute(sql`SELECT current_entity_id() as eid`);
    });

    expect(result.rows[0].eid).toBe(aliceId);
  });

  it('should combine Server RLS + Entity RLS (double isolation)', async () => {
    // Create a manager with wrong server context
    const wrongServerId = uuidv4();
    const wrongServerManager = new PostgresConnectionManager(POSTGRES_URL, wrongServerId);

    try {
      // Even with correct entity_id, wrong server_id should see nothing
      const result = await wrongServerManager.withEntityContext(aliceId as UUID, async (tx) => {
        return await tx.execute(sql`SELECT COUNT(*) as count FROM memories`);
      });

      // Wrong server context blocks access
      expect(parseInt(String(result.rows[0].count))).toBe(0);
    } finally {
      await wrongServerManager.close();
    }
  });
});
