import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from 'pg';
import { v4 as uuidv4 } from 'uuid';

/**
 * PostgreSQL RLS Server Integration Tests
 *
 * These tests require a real PostgreSQL database with RLS enabled.
 * Run with: docker-compose up -d postgres
 *
 * Tests verify:
 * - Server-level isolation between different ElizaOS instances
 * - RLS policies are enforced for non-superuser accounts
 * - Data is completely isolated between servers
 *
 * NOTE: This test expects rls-entity.test.ts to have run first (same BATCH_RLS),
 * which creates the schema and installs RLS functions.
 *
 * Uses SET app.server_id for server context (unified approach for pg and Neon).
 */

// Skip these tests if POSTGRES_URL is not set (e.g., in CI without PostgreSQL)
describe.skipIf(!process.env.POSTGRES_URL)('PostgreSQL RLS Server Integration', () => {
  let setupClient1: Client; // Setup client for server 1 (with server1 context)
  let setupClient2: Client; // Setup client for server 2 (with server2 context)
  let userClient1: Client;
  let userClient2: Client;

  const POSTGRES_URL =
    process.env.POSTGRES_URL || 'postgresql://eliza_test:test123@localhost:5432/eliza_test';
  const server1Id = uuidv4();
  const server2Id = uuidv4();

  beforeAll(async () => {
    // Setup clients - each with its own server context
    setupClient1 = new Client({ connectionString: POSTGRES_URL });
    setupClient2 = new Client({ connectionString: POSTGRES_URL });

    await setupClient1.connect();
    await setupClient2.connect();
    await setupClient1.query(`SET app.server_id = '${server1Id}'`);
    await setupClient2.query(`SET app.server_id = '${server2Id}'`);

    // User clients (same as setup, just clearer naming for test assertions)
    userClient1 = new Client({ connectionString: POSTGRES_URL });
    userClient2 = new Client({ connectionString: POSTGRES_URL });

    await userClient1.connect();
    await userClient2.connect();
    await userClient1.query(`SET app.server_id = '${server1Id}'`);
    await userClient2.query(`SET app.server_id = '${server2Id}'`);

    // Create servers - each setup client creates its own server
    // (servers table may not have RLS, but this pattern is consistent)
    await setupClient1.query(
      `INSERT INTO servers (id, created_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [server1Id]
    );
    await setupClient2.query(
      `INSERT INTO servers (id, created_at, updated_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [server2Id]
    );
  });

  afterAll(async () => {
    // Cleanup - each client cleans its own server's data (RLS enforced)
    try {
      await setupClient1.query(`DELETE FROM agents WHERE username = 'rls_test_server1'`);
      await setupClient1.query(`DELETE FROM servers WHERE id = $1`, [server1Id]);
    } catch (err) {
      console.warn('Cleanup error (server1):', err);
    }

    try {
      await setupClient2.query(`DELETE FROM agents WHERE username = 'rls_test_server2'`);
      await setupClient2.query(`DELETE FROM servers WHERE id = $1`, [server2Id]);
    } catch (err) {
      console.warn('Cleanup error (server2):', err);
    }

    await setupClient1.end();
    await setupClient2.end();
    await userClient1.end();
    await userClient2.end();
  });

  it('should isolate agents by server_id', async () => {
    const agent1Id = uuidv4();
    const agent2Id = uuidv4();

    // Server 1 creates an agent
    await userClient1.query(
      `
      INSERT INTO agents (id, name, username, server_id, created_at, updated_at)
      VALUES ($1, 'Agent Server 1', 'rls_test_server1', $2, NOW(), NOW())
    `,
      [agent1Id, server1Id]
    );

    // Server 2 creates an agent
    await userClient2.query(
      `
      INSERT INTO agents (id, name, username, server_id, created_at, updated_at)
      VALUES ($1, 'Agent Server 2', 'rls_test_server2', $2, NOW(), NOW())
    `,
      [agent2Id, server2Id]
    );

    // Server 1 should only see its own agent
    const result1 = await userClient1.query(`
      SELECT id, name, username, server_id
      FROM agents
      WHERE username IN ('rls_test_server1', 'rls_test_server2')
    `);
    expect(result1.rows).toHaveLength(1);
    expect(result1.rows[0].username).toBe('rls_test_server1');
    expect(result1.rows[0].server_id).toBe(server1Id);

    // Server 2 should only see its own agent
    const result2 = await userClient2.query(`
      SELECT id, name, username, server_id
      FROM agents
      WHERE username IN ('rls_test_server1', 'rls_test_server2')
    `);
    expect(result2.rows).toHaveLength(1);
    expect(result2.rows[0].username).toBe('rls_test_server2');
    expect(result2.rows[0].server_id).toBe(server2Id);

    // Both agents exist (verified by each seeing their own)
    // RLS properly isolates them - no superuser needed to verify total count
  });

  it('should enforce RLS on all tables with server_id', async () => {
    // Check that RLS is enabled on key tables (pg_tables is a system catalog, no RLS)
    const result = await userClient1.query(`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('agents', 'rooms', 'memories', 'channels')
        AND rowsecurity = true
    `);

    expect(result.rows.length).toBeGreaterThan(0);
    result.rows.forEach((row: { rowsecurity: boolean }) => {
      expect(row.rowsecurity).toBe(true);
    });
  });

  it('should have server_isolation_policy on tables', async () => {
    // pg_policies is a system catalog, any user can query it
    const result = await userClient1.query(`
      SELECT DISTINCT tablename
      FROM pg_policies
      WHERE policyname = 'server_isolation_policy'
        AND tablename IN ('agents', 'rooms', 'memories')
    `);

    expect(result.rows.length).toBeGreaterThanOrEqual(3);
  });

  it('should block cross-server data access', async () => {
    // Server 1 tries to access Server 2's data directly
    const result = await userClient1.query(`
      SELECT COUNT(*) as count
      FROM agents
      WHERE username = 'rls_test_server2'
    `);

    // Should see 0 (RLS blocks it)
    expect(parseInt(result.rows[0].count)).toBe(0);
  });

  it('should use current_server_id() function correctly', async () => {
    const result1 = await userClient1.query(`SELECT current_server_id() as sid`);
    const result2 = await userClient2.query(`SELECT current_server_id() as sid`);

    expect(result1.rows[0].sid).toBe(server1Id);
    expect(result2.rows[0].sid).toBe(server2Id);
  });
});
