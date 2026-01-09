import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { v4 as uuidv4 } from 'uuid';
import type { IDatabaseAdapter } from '@elizaos/core';
import { DatabaseMigrationService } from '../../../migration-service';
import { plugin as sqlPlugin } from '../../../index';
import { installRLSFunctions, applyRLSToNewTables, applyEntityRLSToAllTables } from '../../../rls';

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
 *
 * This test is the FIRST in BATCH_RLS and is responsible for:
 * 1. Running migrations to create the schema
 * 2. Installing RLS functions and policies
 *
 * Uses SET app.server_id for server context (unified approach for pg and Neon).
 */

// Skip these tests if POSTGRES_URL is not set (e.g., in CI without PostgreSQL)
describe.skipIf(!process.env.POSTGRES_URL)('PostgreSQL RLS Entity Integration', () => {
  let setupClient: Client; // Setup client with server context
  let userClient: Client;

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
    // Setup client (for migrations and data setup)
    setupClient = new Client({ connectionString: POSTGRES_URL });
    await setupClient.connect();
    // Set server context for the session
    await setupClient.query(`SET app.server_id = '${serverId}'`);

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

    // User client (for test assertions)
    userClient = new Client({ connectionString: POSTGRES_URL });
    await userClient.connect();
    // Set server context for the session
    await userClient.query(`SET app.server_id = '${serverId}'`);

    // Setup test data
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
    await userClient.end();
  });

  it('should block access without entity context', async () => {
    // Without entity context, user should see 0 memories (STRICT mode)
    await userClient.query('BEGIN');
    try {
      const result = await userClient.query(`
        SELECT COUNT(*) as count FROM memories
      `);

      expect(parseInt(result.rows[0].count)).toBe(0);
    } finally {
      await userClient.query('ROLLBACK');
    }
  });

  it('should allow Alice to see room1 memories', async () => {
    await userClient.query('BEGIN');
    try {
      // Set Alice's entity context
      await userClient.query(`SET LOCAL app.entity_id = '${aliceId}'`);

      const result = await userClient.query(`
        SELECT id, room_id, content FROM memories
      `);

      // Alice is in room1, so should see 1 memory
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].room_id).toBe(room1Id);
      expect(result.rows[0].content.text).toContain('room1');
    } finally {
      await userClient.query('ROLLBACK');
    }
  });

  it('should allow Bob to see BOTH room1 and room2 memories', async () => {
    await userClient.query('BEGIN');
    try {
      // Set Bob's entity context
      await userClient.query(`SET LOCAL app.entity_id = '${bobId}'`);

      const result = await userClient.query(`
        SELECT id, room_id, content FROM memories ORDER BY room_id
      `);

      // Bob is in both rooms, so should see 2 memories
      expect(result.rows).toHaveLength(2);
      expect(result.rows.map((r) => r.room_id)).toContain(room1Id);
      expect(result.rows.map((r) => r.room_id)).toContain(room2Id);
    } finally {
      await userClient.query('ROLLBACK');
    }
  });

  it('should allow Charlie to see ONLY room2 memories', async () => {
    await userClient.query('BEGIN');
    try {
      // Set Charlie's entity context
      await userClient.query(`SET LOCAL app.entity_id = '${charlieId}'`);

      const result = await userClient.query(`
        SELECT id, room_id, content FROM memories
      `);

      // Charlie is only in room2
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].room_id).toBe(room2Id);
      expect(result.rows[0].content.text).toContain('room2');
    } finally {
      await userClient.query('ROLLBACK');
    }
  });

  it('should block non-participant from seeing any memories', async () => {
    await userClient.query('BEGIN');
    try {
      const nonParticipantId = uuidv4();

      // Set non-participant entity context
      await userClient.query(`SET LOCAL app.entity_id = '${nonParticipantId}'`);

      const result = await userClient.query(`
        SELECT COUNT(*) as count FROM memories
      `);

      // Non-participant should see 0
      expect(parseInt(result.rows[0].count)).toBe(0);
    } finally {
      await userClient.query('ROLLBACK');
    }
  });

  it('should have entity_isolation_policy on key tables', async () => {
    // pg_policies is a system catalog, any user can query it
    const result = await userClient.query(`
      SELECT DISTINCT tablename
      FROM pg_policies
      WHERE policyname = 'entity_isolation_policy'
        AND tablename IN ('memories', 'participants', 'components', 'logs', 'tasks')
    `);

    expect(result.rows.length).toBeGreaterThanOrEqual(3);
  });

  it('should use current_entity_id() function correctly', async () => {
    await userClient.query('BEGIN');
    try {
      await userClient.query(`SET LOCAL app.entity_id = '${aliceId}'`);

      const result = await userClient.query(`SELECT current_entity_id() as eid`);

      expect(result.rows[0].eid).toBe(aliceId);
    } finally {
      await userClient.query('ROLLBACK');
    }
  });

  it('should combine Server RLS + Entity RLS (double isolation)', async () => {
    // Create a different server context client
    const wrongServerId = uuidv4();
    const wrongServerClient = new Client({ connectionString: POSTGRES_URL });
    await wrongServerClient.connect();
    await wrongServerClient.query(`SET app.server_id = '${wrongServerId}'`);

    try {
      await wrongServerClient.query('BEGIN');
      try {
        // Even with correct entity_id, wrong server_id should see nothing
        await wrongServerClient.query(`SET LOCAL app.entity_id = '${aliceId}'`);

        const result = await wrongServerClient.query(`
          SELECT COUNT(*) as count FROM memories
        `);

        // Wrong server context blocks access
        expect(parseInt(result.rows[0].count)).toBe(0);
      } finally {
        await wrongServerClient.query('ROLLBACK');
      }
    } finally {
      await wrongServerClient.end();
    }
  });
});
