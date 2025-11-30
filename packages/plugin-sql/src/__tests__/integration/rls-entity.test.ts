import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from 'pg';
import { v4 as uuidv4 } from 'uuid';

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
 */

// Skip these tests if POSTGRES_URL is not set (e.g., in CI without PostgreSQL)
describe.skipIf(!process.env.POSTGRES_URL)('PostgreSQL RLS Entity Integration', () => {
  let adminClient: Client;
  let userClient: Client;

  const POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
  const serverId = uuidv4();
  const aliceId = uuidv4();
  const bobId = uuidv4();
  const charlieId = uuidv4();
  const room1Id = uuidv4();
  const room2Id = uuidv4();
  const agentId = uuidv4();

  beforeAll(async () => {
    // Admin client (for setup)
    adminClient = new Client({ connectionString: POSTGRES_URL });
    await adminClient.connect();

    // Create test user
    try {
      await adminClient.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_user WHERE usename = 'eliza_test') THEN
            CREATE USER eliza_test WITH PASSWORD 'test123';
          END IF;
        END
        $$;
      `);
      await adminClient.query(`GRANT ALL ON SCHEMA public TO eliza_test`);
      await adminClient.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO eliza_test`);
      await adminClient.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO eliza_test`);
    } catch (err) {
      console.warn('User creation skipped:', err);
    }

    // User client with server context
    const testUrl = POSTGRES_URL.replace('postgres:postgres', 'eliza_test:test123');
    userClient = new Client({
      connectionString: testUrl,
      application_name: serverId,
    });
    await userClient.connect();

    // Setup test data with admin (bypasses RLS)
    // Note: Admin is superuser, so RLS doesn't apply - we explicitly set server_id in INSERTs

    // Create server
    await adminClient.query(`
      INSERT INTO servers (id, created_at, updated_at)
      VALUES ($1, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `, [serverId]);

    // Create agent
    await adminClient.query(`
      INSERT INTO agents (id, name, username, server_id, created_at, updated_at)
      VALUES ($1, 'Test Agent RLS', $2, $3, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
    `, [agentId, `rls_test_agent_${serverId.substring(0, 8)}`, serverId]);

    // Create entities
    try {
      const result = await adminClient.query(`
        INSERT INTO entities (id, agent_id, names, metadata, server_id, created_at)
        VALUES
          ($1, $4, ARRAY['Alice'], '{}'::jsonb, $5, NOW()),
          ($2, $4, ARRAY['Bob'], '{}'::jsonb, $5, NOW()),
          ($3, $4, ARRAY['Charlie'], '{}'::jsonb, $5, NOW())
        ON CONFLICT (id) DO UPDATE SET names = EXCLUDED.names
        RETURNING id
      `, [aliceId, bobId, charlieId, agentId, serverId]);
      console.log('Entities created:', result.rows.length);
    } catch (err) {
      console.error('Failed to create entities:', err instanceof Error ? err.message : String(err));
      throw err;
    }

    // Create rooms
    await adminClient.query(`
      INSERT INTO rooms (id, "agentId", source, type, server_id, created_at)
      VALUES
        ($1, $3, 'test', 'DM', $4, NOW()),
        ($2, $3, 'test', 'GROUP', $4, NOW())
      ON CONFLICT (id) DO NOTHING
    `, [room1Id, room2Id, agentId, serverId]);

    // Create participants
    // Room1: Alice + Bob
    // Room2: Bob + Charlie
    try {
      const participantResult = await adminClient.query(`
        INSERT INTO participants (id, "entityId", "roomId", server_id, created_at)
        VALUES
          (gen_random_uuid(), $1, $2, $3, NOW()),
          (gen_random_uuid(), $4, $2, $3, NOW()),
          (gen_random_uuid(), $4, $5, $3, NOW()),
          (gen_random_uuid(), $6, $5, $3, NOW())
        ON CONFLICT DO NOTHING
        RETURNING id, "entityId"
      `, [aliceId, room1Id, serverId, bobId, room2Id, charlieId]);
      console.log('Participants created:', participantResult.rows.length, participantResult.rows.map(r => ({e: r.entityId})));
    } catch (err) {
      console.error('Failed to create participants:', err instanceof Error ? err.message : String(err));
      console.log('UUIDs:', { aliceId, bobId, charlieId, room1Id, room2Id, serverId });
      throw err;
    }

    // Create memories
    await adminClient.query(`
      INSERT INTO memories (id, "agentId", "roomId", content, type, server_id, "createdAt")
      VALUES
        (gen_random_uuid(), $1, $2, '{"text": "Message in room1"}', 'message', $4, NOW()),
        (gen_random_uuid(), $1, $3, '{"text": "Message in room2"}', 'message', $4, NOW())
    `, [agentId, room1Id, room2Id, serverId]);
  });

  afterAll(async () => {
    // Cleanup
    try {
      await adminClient.query(`DELETE FROM memories WHERE "roomId" IN ($1, $2)`, [room1Id, room2Id]);
      await adminClient.query(`DELETE FROM participants WHERE "roomId" IN ($1, $2)`, [room1Id, room2Id]);
      await adminClient.query(`DELETE FROM rooms WHERE id IN ($1, $2)`, [room1Id, room2Id]);
      await adminClient.query(`DELETE FROM entities WHERE id IN ($1, $2, $3)`, [aliceId, bobId, charlieId]);
      await adminClient.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
      await adminClient.query(`DELETE FROM servers WHERE id = $1`, [serverId]);
    } catch (err) {
      console.warn('Cleanup error:', err);
    }

    await adminClient.end();
    await userClient.end();
  });

  it('should block access without entity context', async () => {
    // Without entity context, user should see 0 memories
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
        SELECT id, "roomId", content FROM memories
      `);

      // Alice is in room1, so should see 1 memory
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].roomId).toBe(room1Id);
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
        SELECT id, "roomId", content FROM memories ORDER BY "roomId"
      `);

      // Bob is in both rooms, so should see 2 memories
      expect(result.rows).toHaveLength(2);
      expect(result.rows.map((r) => r.roomId)).toContain(room1Id);
      expect(result.rows.map((r) => r.roomId)).toContain(room2Id);
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
        SELECT id, "roomId", content FROM memories
      `);

      // Charlie is only in room2
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].roomId).toBe(room2Id);
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
    const result = await adminClient.query(`
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
    const wrongServerClient = new Client({
      connectionString: POSTGRES_URL.replace('postgres:postgres', 'eliza_test:test123'),
      application_name: wrongServerId,
    });
    await wrongServerClient.connect();

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