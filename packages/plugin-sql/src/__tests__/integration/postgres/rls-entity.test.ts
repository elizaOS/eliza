import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { IDatabaseAdapter, UUID } from '@elizaos/core';
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
  let setupClient: Client; // Setup client for migrations and data setup
  let manager: PostgresConnectionManager; // Production code path for RLS tests

  const POSTGRES_URL =
    process.env.POSTGRES_URL || 'postgresql://eliza_test:test123@localhost:5432/eliza_test';
  const serverId = uuidv4();
  const aliceId = uuidv4();
  const bobId = uuidv4();
  const charlieId = uuidv4();
  const room1Id = uuidv4();
  const room2Id = uuidv4();
  const agentId = uuidv4();

  beforeAll(async () => {
    // Setup client with server context (for migrations and data setup)
    setupClient = new Client({
      connectionString: POSTGRES_URL,
      application_name: serverId,
    });
    await setupClient.connect();

    // Clean up from previous tests - drop all tables and schemas for fresh start
    // Use a superuser connection for cleanup if possible
    const cleanupUrl = new URL(POSTGRES_URL);
    cleanupUrl.username = 'postgres';
    cleanupUrl.password = 'postgres';
    const cleanupClient = new Client({ connectionString: cleanupUrl.toString() });
    try {
      await cleanupClient.connect();
      await cleanupClient.query(`DROP SCHEMA IF EXISTS migrations CASCADE`);
      await cleanupClient.query(`
        DO $$ DECLARE
          r RECORD;
        BEGIN
          FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
            EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
          END LOOP;
        END $$;
      `);
      console.log('[RLS Test] Cleanup complete using superuser');
      await cleanupClient.end();
    } catch (err) {
      console.log('[RLS Test] Superuser cleanup failed, continuing with eliza_test');
      try {
        await cleanupClient.end();
      } catch {
        /* ignore */
      }
    }

    // Initialize schema with migrations
    const db = drizzle(setupClient);
    const migrationService = new DatabaseMigrationService();
    await migrationService.initializeWithDatabase(db);
    migrationService.discoverAndRegisterPluginSchemas([sqlPlugin]);
    await migrationService.runAllPluginMigrations();
    console.log('[RLS Test] Schema initialized via migrations');

    // Install RLS functions and apply to all tables
    const mockAdapter = { db } as IDatabaseAdapter;
    await installRLSFunctions(mockAdapter);
    await applyRLSToNewTables(mockAdapter);
    await applyEntityRLSToAllTables(mockAdapter);
    console.log('[RLS Test] RLS functions installed and applied');

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

    // Setup test data (with server context via application_name)
    // servers table has no RLS, so any connection can insert
    await setupClient.query(
      `INSERT INTO servers (id, created_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [serverId]
    );

    // Create agent (server_id will be set by DEFAULT current_server_id())
    await setupClient.query(
      `INSERT INTO agents (id, name, username, server_id, created_at, updated_at)
       VALUES ($1, 'Test Agent RLS', $2, $3, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [agentId, `rls_test_agent_${serverId.substring(0, 8)}`, serverId]
    );

    // Create entities
    try {
      const result = await setupClient.query(
        `INSERT INTO entities (id, agent_id, names, metadata, created_at)
         VALUES
           ($1, $4, ARRAY['Alice'], '{}'::jsonb, NOW()),
           ($2, $4, ARRAY['Bob'], '{}'::jsonb, NOW()),
           ($3, $4, ARRAY['Charlie'], '{}'::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET names = EXCLUDED.names
         RETURNING id`,
        [aliceId, bobId, charlieId, agentId]
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
    await setupClient.query(
      `INSERT INTO rooms (id, agent_id, source, type, created_at)
       VALUES
         ($1, $3, 'test', 'DM', NOW()),
         ($2, $3, 'test', 'GROUP', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [room1Id, room2Id, agentId]
    );

    // Create participants
    // Room1: Alice + Bob
    // Room2: Bob + Charlie
    try {
      const participantResult = await setupClient.query(
        `INSERT INTO participants (id, entity_id, room_id, agent_id, created_at)
         VALUES
           (gen_random_uuid(), $1, $2, $4, NOW()),
           (gen_random_uuid(), $3, $2, $4, NOW()),
           (gen_random_uuid(), $3, $5, $4, NOW()),
           (gen_random_uuid(), $6, $5, $4, NOW())
         ON CONFLICT DO NOTHING
         RETURNING id, entity_id`,
        [aliceId, room1Id, bobId, agentId, room2Id, charlieId]
      );
      console.log(
        '[RLS Test] Participants created:',
        participantResult.rows.length,
        participantResult.rows.map((r) => ({ e: r.entity_id?.substring(0, 8) }))
      );
    } catch (err) {
      console.error(
        '[RLS Test] Failed to create participants:',
        err instanceof Error ? err.message : String(err)
      );
      console.log('UUIDs:', { aliceId, bobId, charlieId, room1Id, room2Id, agentId });
      throw err;
    }

    // Create memories (STRICT Entity RLS - need entity context)
    // Memory in room1 (accessible to Alice and Bob)
    await setupClient.query('BEGIN');
    await setupClient.query(`SET LOCAL app.entity_id = '${aliceId}'`);
    await setupClient.query(
      `INSERT INTO memories (id, agent_id, room_id, content, type, created_at)
       VALUES (gen_random_uuid(), $1, $2, '{"text": "Message in room1"}', 'message', NOW())`,
      [agentId, room1Id]
    );
    await setupClient.query('COMMIT');

    // Memory in room2 (accessible to Bob and Charlie)
    await setupClient.query('BEGIN');
    await setupClient.query(`SET LOCAL app.entity_id = '${bobId}'`);
    await setupClient.query(
      `INSERT INTO memories (id, agent_id, room_id, content, type, created_at)
       VALUES (gen_random_uuid(), $1, $2, '{"text": "Message in room2"}', 'message', NOW())`,
      [agentId, room2Id]
    );
    await setupClient.query('COMMIT');

    console.log('[RLS Test] Test data setup complete');
  });

  afterAll(async () => {
    // Cleanup - need entity context for STRICT tables like memories
    try {
      // Delete memories with entity context
      await setupClient.query('BEGIN');
      await setupClient.query(`SET LOCAL app.entity_id = '${aliceId}'`);
      await setupClient.query(`DELETE FROM memories WHERE room_id = $1`, [room1Id]);
      await setupClient.query('COMMIT');

      await setupClient.query('BEGIN');
      await setupClient.query(`SET LOCAL app.entity_id = '${bobId}'`);
      await setupClient.query(`DELETE FROM memories WHERE room_id = $1`, [room2Id]);
      await setupClient.query('COMMIT');

      // Delete other data (non-STRICT tables)
      await setupClient.query(`DELETE FROM participants WHERE room_id IN ($1, $2)`, [
        room1Id,
        room2Id,
      ]);
      await setupClient.query(`DELETE FROM rooms WHERE id IN ($1, $2)`, [room1Id, room2Id]);
      await setupClient.query(`DELETE FROM entities WHERE id IN ($1, $2, $3)`, [
        aliceId,
        bobId,
        charlieId,
      ]);
      await setupClient.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
      await setupClient.query(`DELETE FROM servers WHERE id = $1`, [serverId]);
    } catch (err) {
      console.warn('[RLS Test] Cleanup error:', err);
    }

    await setupClient.end();
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
