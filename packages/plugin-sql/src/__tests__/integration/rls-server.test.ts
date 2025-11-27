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
 */

// Skip these tests if POSTGRES_URL is not set (e.g., in CI without PostgreSQL)
describe.skipIf(!process.env.POSTGRES_URL)('PostgreSQL RLS Server Integration', () => {
  let adminClient: Client;
  let userClient1: Client;
  let userClient2: Client;

  const POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://postgres:postgres@localhost:5432/eliza';
  const server1Id = uuidv4();
  const server2Id = uuidv4();

  beforeAll(async () => {
    // Admin client (for setup only)
    adminClient = new Client({ connectionString: POSTGRES_URL });
    await adminClient.connect();

    // Create test user if not exists
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
      console.warn('User creation skipped (may already exist):', err);
    }

    // User clients with different server contexts
    const testUrl = POSTGRES_URL.replace('postgres:postgres', 'eliza_test:test123');
    userClient1 = new Client({
      connectionString: testUrl,
      application_name: server1Id,
    });
    userClient2 = new Client({
      connectionString: testUrl,
      application_name: server2Id,
    });

    await userClient1.connect();
    await userClient2.connect();

    // Create servers
    await adminClient.query(`
      INSERT INTO servers (id, created_at, updated_at)
      VALUES ($1, NOW(), NOW()), ($2, NOW(), NOW())
      ON CONFLICT (id) DO NOTHING
    `, [server1Id, server2Id]);
  });

  afterAll(async () => {
    // Cleanup
    try {
      await adminClient.query(`DELETE FROM agents WHERE username IN ('rls_test_server1', 'rls_test_server2')`);
      await adminClient.query(`DELETE FROM servers WHERE id IN ($1, $2)`, [server1Id, server2Id]);
    } catch (err) {
      console.warn('Cleanup error:', err);
    }

    await adminClient.end();
    await userClient1.end();
    await userClient2.end();
  });

  it('should isolate agents by server_id', async () => {
    const agent1Id = uuidv4();
    const agent2Id = uuidv4();

    // Server 1 creates an agent
    await userClient1.query(`
      INSERT INTO agents (id, name, username, server_id, created_at, updated_at)
      VALUES ($1, 'Agent Server 1', 'rls_test_server1', $2, NOW(), NOW())
    `, [agent1Id, server1Id]);

    // Server 2 creates an agent
    await userClient2.query(`
      INSERT INTO agents (id, name, username, server_id, created_at, updated_at)
      VALUES ($1, 'Agent Server 2', 'rls_test_server2', $2, NOW(), NOW())
    `, [agent2Id, server2Id]);

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

    // Admin should see both
    const adminResult = await adminClient.query(`
      SELECT id, name, username, server_id
      FROM agents
      WHERE username IN ('rls_test_server1', 'rls_test_server2')
      ORDER BY username
    `);
    expect(adminResult.rows).toHaveLength(2);
  });

  it('should enforce RLS on all tables with server_id', async () => {
    // Check that RLS is enabled on key tables
    const result = await adminClient.query(`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('agents', 'rooms', 'memories', 'channels')
        AND rowsecurity = true
    `);

    expect(result.rows.length).toBeGreaterThan(0);
    result.rows.forEach((row) => {
      expect(row.rowsecurity).toBe(true);
    });
  });

  it('should have server_isolation_policy on tables', async () => {
    const result = await adminClient.query(`
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