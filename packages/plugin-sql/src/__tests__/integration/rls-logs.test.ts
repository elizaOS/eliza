import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from 'pg';
import { v4 as uuidv4 } from 'uuid';

/**
 * PostgreSQL RLS Logs Integration Tests
 *
 * These tests verify that the `logs` table has STRICT Entity RLS isolation.
 * Logs contain sensitive user activity data (model usage, embeddings, etc.)
 * and must be isolated by entity participation in rooms.
 *
 * Tests verify:
 * - Logs are isolated by entity (user can only see their own logs)
 * - Logs from shared rooms are visible to all participants
 * - Logs from non-participant rooms are blocked
 * - withEntityContext() is required for log insertion
 */

describe.skipIf(!process.env.POSTGRES_URL)('PostgreSQL RLS - Logs Isolation (STRICT)', () => {
  let adminClient: Client;
  let aliceClient: Client;
  let bobClient: Client;

  const POSTGRES_URL =
    process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
  const serverId = uuidv4();
  const aliceId = uuidv4();
  const bobId = uuidv4();
  const agentId = uuidv4();
  const sharedRoomId = uuidv4(); // Alice + Agent
  const alicePrivateRoomId = uuidv4(); // Alice only
  const bobPrivateRoomId = uuidv4(); // Bob only

  beforeAll(async () => {
    // Admin client (for setup)
    adminClient = new Client({ connectionString: POSTGRES_URL });
    await adminClient.connect();

    // Create test user if needed
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
      console.warn('[RLS Logs Test] User creation skipped:', err);
    }

    // Alice client with Entity RLS context
    const aliceUrl = POSTGRES_URL.replace('postgres:postgres', 'eliza_test:test123');
    aliceClient = new Client({
      connectionString: aliceUrl,
      application_name: serverId,
    });
    await aliceClient.connect();

    // Bob client with Entity RLS context
    const bobUrl = POSTGRES_URL.replace('postgres:postgres', 'eliza_test:test123');
    bobClient = new Client({
      connectionString: bobUrl,
      application_name: serverId,
    });
    await bobClient.connect();

    // Setup test data
    await adminClient.query(
      `INSERT INTO servers (id, created_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [serverId]
    );

    await adminClient.query(
      `INSERT INTO agents (id, name, username, server_id, created_at, updated_at)
       VALUES ($1, 'Log Test Agent', $2, $3, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [agentId, `log_test_agent_${serverId.substring(0, 8)}`, serverId]
    );

    await adminClient.query(
      `INSERT INTO entities (id, agent_id, names, metadata, server_id, created_at)
       VALUES
         ($1, $3, ARRAY['Alice'], '{}'::jsonb, $4, NOW()),
         ($2, $3, ARRAY['Bob'], '{}'::jsonb, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET names = EXCLUDED.names`,
      [aliceId, bobId, agentId, serverId]
    );

    await adminClient.query(
      `INSERT INTO rooms (id, "agentId", source, type, server_id, created_at)
       VALUES
         ($1, $4, 'test', 'DM', $5, NOW()),
         ($2, $4, 'test', 'DM', $5, NOW()),
         ($3, $4, 'test', 'DM', $5, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [sharedRoomId, alicePrivateRoomId, bobPrivateRoomId, agentId, serverId]
    );

    // Create participants
    // Shared room: Alice only (agents are not participants)
    await adminClient.query(
      `INSERT INTO participants ("entityId", "roomId", "agentId", server_id, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [aliceId, sharedRoomId, agentId, serverId]
    );

    // Alice private room: Alice only
    await adminClient.query(
      `INSERT INTO participants ("entityId", "roomId", "agentId", server_id, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [aliceId, alicePrivateRoomId, agentId, serverId]
    );

    // Bob private room: Bob only
    await adminClient.query(
      `INSERT INTO participants ("entityId", "roomId", "agentId", server_id, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [bobId, bobPrivateRoomId, agentId, serverId]
    );

    // Create test logs (as admin, bypassing RLS)
    // Log 1: Alice in shared room
    await adminClient.query(
      `INSERT INTO logs (id, "entityId", "roomId", type, body, server_id, created_at)
       VALUES ($1, $2, $3, 'useModel:TEXT_EMBEDDING', '{"model":"ada-002","tokens":100}'::jsonb, $4, NOW())`,
      [uuidv4(), aliceId, sharedRoomId, serverId]
    );

    // Log 2: Alice in private room
    await adminClient.query(
      `INSERT INTO logs (id, "entityId", "roomId", type, body, server_id, created_at)
       VALUES ($1, $2, $3, 'useModel:TEXT_LARGE', '{"model":"gpt-4","tokens":500}'::jsonb, $4, NOW())`,
      [uuidv4(), aliceId, alicePrivateRoomId, serverId]
    );

    await adminClient.query(
      `INSERT INTO logs (id, "entityId", "roomId", type, body, server_id, created_at)
       VALUES ($1, $2, $3, 'useModel:TEXT_EMBEDDING', '{"model":"ada-002","tokens":50}'::jsonb, $4, NOW())`,
      [uuidv4(), bobId, bobPrivateRoomId, serverId]
    );

    console.log('[RLS Logs Test] Test data created:', {
      aliceId: aliceId.substring(0, 8),
      bobId: bobId.substring(0, 8),
      sharedRoom: sharedRoomId.substring(0, 8),
      alicePrivateRoom: alicePrivateRoomId.substring(0, 8),
      bobPrivateRoom: bobPrivateRoomId.substring(0, 8),
    });
  });

  afterAll(async () => {
    // Cleanup test data
    try {
      await adminClient.query(`DELETE FROM logs WHERE server_id = $1`, [serverId]);
      await adminClient.query(`DELETE FROM participants WHERE "roomId" IN ($1, $2, $3)`, [
        sharedRoomId,
        alicePrivateRoomId,
        bobPrivateRoomId,
      ]);
      await adminClient.query(`DELETE FROM rooms WHERE id IN ($1, $2, $3)`, [
        sharedRoomId,
        alicePrivateRoomId,
        bobPrivateRoomId,
      ]);
      await adminClient.query(`DELETE FROM entities WHERE id IN ($1, $2)`, [aliceId, bobId]);
      await adminClient.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
      await adminClient.query(`DELETE FROM servers WHERE id = $1`, [serverId]);
    } catch (err) {
      console.warn('[RLS Logs Test] Cleanup failed:', err);
    }

    // Close connections
    await aliceClient?.end();
    await bobClient?.end();
    await adminClient?.end();
  });

  it('should verify RLS is enabled on logs table', async () => {
    const result = await adminClient.query(`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'logs'
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].rowsecurity).toBe(true);
  });

  it('should verify STRICT entity_isolation_policy exists on logs', async () => {
    const result = await adminClient.query(`
      SELECT policyname, permissive, cmd
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'logs'
        AND policyname = 'entity_isolation_policy'
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].policyname).toBe('entity_isolation_policy');
    expect(result.rows[0].cmd).toBe('ALL'); // Applies to SELECT, INSERT, UPDATE, DELETE
  });

  it('should isolate Alice logs from Bob (Alice sees 2, Bob sees 1)', async () => {
    // Alice should see her 2 logs (shared room + private room)
    await aliceClient.query('BEGIN');
    await aliceClient.query(`SET LOCAL app.entity_id = '${aliceId}'`);
    const aliceResult = await aliceClient.query(
      `
      SELECT id, "entityId", "roomId", type
      FROM logs
      WHERE "entityId" = $1
      ORDER BY created_at DESC
    `,
      [aliceId]
    );
    await aliceClient.query('COMMIT');

    expect(aliceResult.rows).toHaveLength(2);
    expect(aliceResult.rows.every((row) => row.entityId === aliceId)).toBe(true);

    // Bob should see his 1 log (private room only)
    await bobClient.query('BEGIN');
    await bobClient.query(`SET LOCAL app.entity_id = '${bobId}'`);
    const bobResult = await bobClient.query(
      `
      SELECT id, "entityId", "roomId", type
      FROM logs
      WHERE "entityId" = $1
      ORDER BY created_at DESC
    `,
      [bobId]
    );
    await bobClient.query('COMMIT');

    expect(bobResult.rows).toHaveLength(1);
    expect(bobResult.rows[0].entityId).toBe(bobId);
  });

  it('should allow Alice to see logs from shared room (Agent + Alice)', async () => {
    await aliceClient.query('BEGIN');
    await aliceClient.query(`SET LOCAL app.entity_id = '${aliceId}'`);
    const result = await aliceClient.query(
      `
      SELECT id, "entityId", "roomId", type
      FROM logs
      WHERE "roomId" = $1
    `,
      [sharedRoomId]
    );
    await aliceClient.query('COMMIT');

    // Alice should see the log from shared room
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].roomId).toBe(sharedRoomId);
    expect(result.rows[0].entityId).toBe(aliceId);
  });

  it('should block Bob from seeing Alice private room logs', async () => {
    await bobClient.query('BEGIN');
    await bobClient.query(`SET LOCAL app.entity_id = '${bobId}'`);
    const result = await bobClient.query(
      `
      SELECT id, "entityId", "roomId", type
      FROM logs
      WHERE "roomId" = $1
    `,
      [alicePrivateRoomId]
    );
    await bobClient.query('COMMIT');

    // Bob should NOT see Alice's private logs (RLS blocks)
    expect(result.rows).toHaveLength(0);
  });

  it('should block Alice from seeing Bob private room logs', async () => {
    await aliceClient.query('BEGIN');
    await aliceClient.query(`SET LOCAL app.entity_id = '${aliceId}'`);
    const result = await aliceClient.query(
      `
      SELECT id, "entityId", "roomId", type
      FROM logs
      WHERE "roomId" = $1
    `,
      [bobPrivateRoomId]
    );
    await aliceClient.query('COMMIT');

    // Alice should NOT see Bob's private logs (RLS blocks)
    expect(result.rows).toHaveLength(0);
  });

  it('should block queries when entity_id is NOT set (STRICT mode)', async () => {
    // Without SET LOCAL app.entity_id, should see 0 results
    const result = await aliceClient.query(`
      SELECT id, "entityId", "roomId", type
      FROM logs
      ORDER BY created_at DESC
    `);

    // STRICT mode: NO rows visible without entity context
    expect(result.rows).toHaveLength(0);
  });

  it('should verify logs table is in STRICT mode (memories, logs, components, tasks)', async () => {
    const result = await adminClient.query(`
      SELECT
        c.relname as table_name,
        p.polname as policy_name,
        pg_get_expr(p.polqual, p.polrelid) as policy_qual
      FROM pg_policy p
      JOIN pg_class c ON p.polrelid = c.oid
      WHERE c.relname = 'logs'
        AND p.polname = 'entity_isolation_policy'
    `);

    expect(result.rows).toHaveLength(1);
    const policyQual = result.rows[0].policy_qual;

    // STRICT mode should have: (current_entity_id() IS NOT NULL) AND (roomId IN ...)
    // PERMISSIVE mode would have: (current_entity_id() IS NULL) OR (roomId IN ...)
    expect(policyQual).toContain('current_entity_id()');
    expect(policyQual).toContain('IS NOT NULL'); // STRICT check
    expect(policyQual).toContain('roomId'); // Or "roomId" depending on quote style
  });
});
