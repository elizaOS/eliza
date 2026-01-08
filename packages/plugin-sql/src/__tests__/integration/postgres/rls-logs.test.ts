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
 *
 * NOTE: This test expects rls-entity.test.ts to have run first (same BATCH_RLS),
 * which creates the schema and installs RLS functions.
 *
 * Uses SET app.server_id for server context (unified approach for pg and Neon).
 */

describe.skipIf(!process.env.POSTGRES_URL)('PostgreSQL RLS - Logs Isolation (STRICT)', () => {
  let setupClient: Client; // Setup client with server context
  let aliceClient: Client;
  let bobClient: Client;

  const POSTGRES_URL =
    process.env.POSTGRES_URL || 'postgresql://eliza_test:test123@localhost:5432/eliza_test';
  const serverId = uuidv4();
  const aliceId = uuidv4();
  const bobId = uuidv4();
  const agentId = uuidv4();
  const sharedRoomId = uuidv4(); // Alice + Agent
  const alicePrivateRoomId = uuidv4(); // Alice only
  const bobPrivateRoomId = uuidv4(); // Bob only

  beforeAll(async () => {
    // Setup client (for creating test data)
    setupClient = new Client({ connectionString: POSTGRES_URL });
    await setupClient.connect();
    await setupClient.query(`SET app.server_id = '${serverId}'`);

    // Alice client
    aliceClient = new Client({ connectionString: POSTGRES_URL });
    await aliceClient.connect();
    await aliceClient.query(`SET app.server_id = '${serverId}'`);

    // Bob client
    bobClient = new Client({ connectionString: POSTGRES_URL });
    await bobClient.connect();
    await bobClient.query(`SET app.server_id = '${serverId}'`);

    // Setup test data
    // servers table has no RLS, so any connection can insert
    await setupClient.query(
      `INSERT INTO servers (id, created_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [serverId]
    );

    await setupClient.query(
      `INSERT INTO agents (id, name, username, server_id, created_at, updated_at)
       VALUES ($1, 'Log Test Agent', $2, $3, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [agentId, `log_test_agent_${serverId.substring(0, 8)}`, serverId]
    );

    await setupClient.query(
      `INSERT INTO entities (id, agent_id, names, metadata, created_at)
       VALUES
         ($1, $3, ARRAY['Alice'], '{}'::jsonb, NOW()),
         ($2, $3, ARRAY['Bob'], '{}'::jsonb, NOW())
       ON CONFLICT (id) DO UPDATE SET names = EXCLUDED.names`,
      [aliceId, bobId, agentId]
    );

    await setupClient.query(
      `INSERT INTO rooms (id, agent_id, source, type, created_at)
       VALUES
         ($1, $4, 'test', 'DM', NOW()),
         ($2, $4, 'test', 'DM', NOW()),
         ($3, $4, 'test', 'DM', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [sharedRoomId, alicePrivateRoomId, bobPrivateRoomId, agentId]
    );

    // Create participants (using snake_case column names)
    // Shared room: Alice only (agents are not participants)
    await setupClient.query(
      `INSERT INTO participants (entity_id, room_id, agent_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [aliceId, sharedRoomId, agentId]
    );

    // Alice private room: Alice only
    await setupClient.query(
      `INSERT INTO participants (entity_id, room_id, agent_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [aliceId, alicePrivateRoomId, agentId]
    );

    // Bob private room: Bob only
    await setupClient.query(
      `INSERT INTO participants (entity_id, room_id, agent_id, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [bobId, bobPrivateRoomId, agentId]
    );

    // Create test logs (using snake_case column names)
    // Need to use entity context for STRICT RLS tables
    await setupClient.query('BEGIN');
    await setupClient.query(`SET LOCAL app.entity_id = '${aliceId}'`);

    // Log 1: Alice in shared room
    await setupClient.query(
      `INSERT INTO logs (id, entity_id, room_id, type, body, created_at)
       VALUES ($1, $2, $3, 'useModel:TEXT_EMBEDDING', '{"model":"ada-002","tokens":100}'::jsonb, NOW())`,
      [uuidv4(), aliceId, sharedRoomId]
    );

    // Log 2: Alice in private room
    await setupClient.query(
      `INSERT INTO logs (id, entity_id, room_id, type, body, created_at)
       VALUES ($1, $2, $3, 'useModel:TEXT_LARGE', '{"model":"gpt-4","tokens":500}'::jsonb, NOW())`,
      [uuidv4(), aliceId, alicePrivateRoomId]
    );

    await setupClient.query('COMMIT');

    // Bob's log (with Bob's entity context)
    await setupClient.query('BEGIN');
    await setupClient.query(`SET LOCAL app.entity_id = '${bobId}'`);
    await setupClient.query(
      `INSERT INTO logs (id, entity_id, room_id, type, body, created_at)
       VALUES ($1, $2, $3, 'useModel:TEXT_EMBEDDING', '{"model":"ada-002","tokens":50}'::jsonb, NOW())`,
      [uuidv4(), bobId, bobPrivateRoomId]
    );
    await setupClient.query('COMMIT');

    console.log('[RLS Logs Test] Test data created:', {
      aliceId: aliceId.substring(0, 8),
      bobId: bobId.substring(0, 8),
      sharedRoom: sharedRoomId.substring(0, 8),
      alicePrivateRoom: alicePrivateRoomId.substring(0, 8),
      bobPrivateRoom: bobPrivateRoomId.substring(0, 8),
    });
  });

  afterAll(async () => {
    // Cleanup test data (need entity context for STRICT tables)
    try {
      // Delete logs with entity context
      await setupClient.query('BEGIN');
      await setupClient.query(`SET LOCAL app.entity_id = '${aliceId}'`);
      await setupClient.query(`DELETE FROM logs WHERE room_id IN ($1, $2)`, [
        sharedRoomId,
        alicePrivateRoomId,
      ]);
      await setupClient.query('COMMIT');

      await setupClient.query('BEGIN');
      await setupClient.query(`SET LOCAL app.entity_id = '${bobId}'`);
      await setupClient.query(`DELETE FROM logs WHERE room_id = $1`, [bobPrivateRoomId]);
      await setupClient.query('COMMIT');

      // Delete other data (non-STRICT tables)
      await setupClient.query(`DELETE FROM participants WHERE room_id IN ($1, $2, $3)`, [
        sharedRoomId,
        alicePrivateRoomId,
        bobPrivateRoomId,
      ]);
      await setupClient.query(`DELETE FROM rooms WHERE id IN ($1, $2, $3)`, [
        sharedRoomId,
        alicePrivateRoomId,
        bobPrivateRoomId,
      ]);
      await setupClient.query(`DELETE FROM entities WHERE id IN ($1, $2)`, [aliceId, bobId]);
      await setupClient.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
      await setupClient.query(`DELETE FROM servers WHERE id = $1`, [serverId]);
    } catch (err) {
      console.warn('[RLS Logs Test] Cleanup failed:', err);
    }

    // Close connections
    await setupClient?.end();
    await aliceClient?.end();
    await bobClient?.end();
  });

  it('should verify RLS is enabled on logs table', async () => {
    const result = await setupClient.query(`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'logs'
    `);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].rowsecurity).toBe(true);
  });

  it('should verify STRICT entity_isolation_policy exists on logs', async () => {
    const result = await setupClient.query(`
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
      SELECT id, entity_id, room_id, type
      FROM logs
      WHERE entity_id = $1
      ORDER BY created_at DESC
    `,
      [aliceId]
    );
    await aliceClient.query('COMMIT');

    expect(aliceResult.rows).toHaveLength(2);
    expect(aliceResult.rows.every((row) => row.entity_id === aliceId)).toBe(true);

    // Bob should see his 1 log (private room only)
    await bobClient.query('BEGIN');
    await bobClient.query(`SET LOCAL app.entity_id = '${bobId}'`);
    const bobResult = await bobClient.query(
      `
      SELECT id, entity_id, room_id, type
      FROM logs
      WHERE entity_id = $1
      ORDER BY created_at DESC
    `,
      [bobId]
    );
    await bobClient.query('COMMIT');

    expect(bobResult.rows).toHaveLength(1);
    expect(bobResult.rows[0].entity_id).toBe(bobId);
  });

  it('should allow Alice to see logs from shared room (Agent + Alice)', async () => {
    await aliceClient.query('BEGIN');
    await aliceClient.query(`SET LOCAL app.entity_id = '${aliceId}'`);
    const result = await aliceClient.query(
      `
      SELECT id, entity_id, room_id, type
      FROM logs
      WHERE room_id = $1
    `,
      [sharedRoomId]
    );
    await aliceClient.query('COMMIT');

    // Alice should see the log from shared room
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].room_id).toBe(sharedRoomId);
    expect(result.rows[0].entity_id).toBe(aliceId);
  });

  it('should block Bob from seeing Alice private room logs', async () => {
    await bobClient.query('BEGIN');
    await bobClient.query(`SET LOCAL app.entity_id = '${bobId}'`);
    const result = await bobClient.query(
      `
      SELECT id, entity_id, room_id, type
      FROM logs
      WHERE room_id = $1
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
      SELECT id, entity_id, room_id, type
      FROM logs
      WHERE room_id = $1
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
      SELECT id, entity_id, room_id, type
      FROM logs
      ORDER BY created_at DESC
    `);

    // STRICT mode: NO rows visible without entity context
    expect(result.rows).toHaveLength(0);
  });

  it('should verify logs table is in STRICT mode (memories, logs, components, tasks)', async () => {
    const result = await setupClient.query(`
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

    // STRICT mode should have: (current_entity_id() IS NOT NULL) AND (room_id IN ...)
    // PERMISSIVE mode would have: (current_entity_id() IS NULL) OR (room_id IN ...)
    expect(policyQual).toContain('current_entity_id()');
    expect(policyQual).toContain('IS NOT NULL'); // STRICT check
    expect(policyQual).toContain('room_id'); // snake_case column name
  });
});
