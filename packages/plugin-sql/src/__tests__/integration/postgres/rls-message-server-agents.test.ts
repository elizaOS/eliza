import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from 'pg';
import { v4 as uuidv4 } from 'uuid';

/**
 * PostgreSQL RLS Integration Tests for message_server_agents
 *
 * Tests verify that Server A cannot see message_server_agents entries from Server B
 * This ensures proper isolation of Discord/Telegram server associations
 *
 * NOTE: This test expects rls-entity.test.ts to have run first (same BATCH_RLS),
 * which creates the schema and installs RLS functions.
 *
 * Uses SET app.server_id for server context (unified approach for pg and Neon).
 */

describe.skipIf(!process.env.POSTGRES_URL)(
  'PostgreSQL RLS - message_server_agents Isolation',
  () => {
    let setupClientA: Client; // Setup client for server A
    let setupClientB: Client; // Setup client for server B
    let serverAClient: Client;
    let serverBClient: Client;

    const POSTGRES_URL =
      process.env.POSTGRES_URL || 'postgresql://eliza_test:test123@localhost:5432/eliza_test';
    const serverAId = uuidv4();
    const serverBId = uuidv4();
    const agentAId = uuidv4();
    const agentBId = uuidv4();
    const messageServerA1Id = uuidv4();
    const messageServerA2Id = uuidv4();
    const messageServerB1Id = uuidv4();

    beforeAll(async () => {
      // Setup clients - each with its own server context
      setupClientA = new Client({ connectionString: POSTGRES_URL });
      setupClientB = new Client({ connectionString: POSTGRES_URL });

      await setupClientA.connect();
      await setupClientB.connect();
      await setupClientA.query(`SET app.server_id = '${serverAId}'`);
      await setupClientB.query(`SET app.server_id = '${serverBId}'`);

      // User clients (same as setup, just clearer naming)
      serverAClient = new Client({ connectionString: POSTGRES_URL });
      serverBClient = new Client({ connectionString: POSTGRES_URL });

      await serverAClient.connect();
      await serverBClient.connect();
      await serverAClient.query(`SET app.server_id = '${serverAId}'`);
      await serverBClient.query(`SET app.server_id = '${serverBId}'`);

      // Create RLS servers (servers table has no RLS)
      await setupClientA.query(
        `INSERT INTO servers (id, created_at, updated_at)
         VALUES ($1, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [serverAId]
      );
      await setupClientB.query(
        `INSERT INTO servers (id, created_at, updated_at)
         VALUES ($1, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [serverBId]
      );

      // Create agents for each server (each client creates its own server's agent)
      await setupClientA.query(
        `INSERT INTO agents (id, name, username, server_id, created_at, updated_at)
         VALUES ($1, 'Agent A', 'rls_test_agent_a', $2, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [agentAId, serverAId]
      );
      await setupClientB.query(
        `INSERT INTO agents (id, name, username, server_id, created_at, updated_at)
         VALUES ($1, 'Agent B', 'rls_test_agent_b', $2, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [agentBId, serverBId]
      );

      // Create message servers (each client creates its own)
      await setupClientA.query(
        `INSERT INTO message_servers (id, source_type, source_id, name, server_id, created_at, updated_at)
         VALUES
           ($1, 'discord', 'discord_a1', 'Discord Server A1', $3, NOW(), NOW()),
           ($2, 'discord', 'discord_a2', 'Discord Server A2', $3, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [messageServerA1Id, messageServerA2Id, serverAId]
      );
      await setupClientB.query(
        `INSERT INTO message_servers (id, source_type, source_id, name, server_id, created_at, updated_at)
         VALUES ($1, 'discord', 'discord_b1', 'Discord Server B1', $2, NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [messageServerB1Id, serverBId]
      );
    });

    afterAll(async () => {
      // Cleanup - each client cleans its own server's data (RLS enforced)
      try {
        await setupClientA.query(`DELETE FROM message_server_agents WHERE agent_id = $1`, [
          agentAId,
        ]);
        await setupClientA.query(`DELETE FROM message_servers WHERE id IN ($1, $2)`, [
          messageServerA1Id,
          messageServerA2Id,
        ]);
        await setupClientA.query(`DELETE FROM agents WHERE id = $1`, [agentAId]);
        await setupClientA.query(`DELETE FROM servers WHERE id = $1`, [serverAId]);
      } catch (err) {
        console.warn('Cleanup error (server A):', err);
      }

      try {
        await setupClientB.query(`DELETE FROM message_server_agents WHERE agent_id = $1`, [
          agentBId,
        ]);
        await setupClientB.query(`DELETE FROM message_servers WHERE id = $1`, [messageServerB1Id]);
        await setupClientB.query(`DELETE FROM agents WHERE id = $1`, [agentBId]);
        await setupClientB.query(`DELETE FROM servers WHERE id = $1`, [serverBId]);
      } catch (err) {
        console.warn('Cleanup error (server B):', err);
      }

      await setupClientA.end();
      await setupClientB.end();
      await serverAClient.end();
      await serverBClient.end();
    });

    it('should isolate message_server_agents entries by server_id', async () => {
      // Server A creates associations
      await serverAClient.query(
        `
      INSERT INTO message_server_agents (message_server_id, agent_id)
      VALUES ($1, $2), ($3, $2)
    `,
        [messageServerA1Id, agentAId, messageServerA2Id]
      );

      // Server B creates association
      await serverBClient.query(
        `
      INSERT INTO message_server_agents (message_server_id, agent_id)
      VALUES ($1, $2)
    `,
        [messageServerB1Id, agentBId]
      );

      // Server A should only see its own associations (2 entries)
      const resultA = await serverAClient.query(`
      SELECT message_server_id, agent_id, server_id
      FROM message_server_agents
      ORDER BY message_server_id
    `);
      expect(resultA.rows).toHaveLength(2);
      expect(resultA.rows[0].agent_id).toBe(agentAId);
      expect(resultA.rows[1].agent_id).toBe(agentAId);
      expect(resultA.rows[0].server_id).toBe(serverAId);
      expect(resultA.rows[1].server_id).toBe(serverAId);

      // Server B should only see its own association (1 entry)
      const resultB = await serverBClient.query(`
      SELECT message_server_id, agent_id, server_id
      FROM message_server_agents
      ORDER BY message_server_id
    `);
      expect(resultB.rows).toHaveLength(1);
      expect(resultB.rows[0].agent_id).toBe(agentBId);
      expect(resultB.rows[0].server_id).toBe(serverBId);

      // Both servers have their data (verified by individual queries above)
      // RLS properly isolates them - no superuser needed to verify total count
    });

    it('should auto-populate server_id with current_server_id()', async () => {
      // Insert without specifying server_id
      await serverAClient.query(
        `
      INSERT INTO message_server_agents (message_server_id, agent_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `,
        [messageServerA1Id, agentAId]
      );

      // Verify server_id was set automatically (query with same server context)
      const result = await serverAClient.query(
        `
      SELECT server_id
      FROM message_server_agents
      WHERE message_server_id = $1 AND agent_id = $2
    `,
        [messageServerA1Id, agentAId]
      );

      expect(result.rows[0].server_id).toBe(serverAId);
    });

    it('should prevent Server A from seeing Server B message servers via JOIN', async () => {
      // Server A tries to find all message_servers via JOIN
      const result = await serverAClient.query(
        `
      SELECT ms.id, ms.name, msa.agent_id
      FROM message_servers ms
      LEFT JOIN message_server_agents msa ON ms.id = msa.message_server_id
      WHERE ms.id IN ($1, $2, $3)
    `,
        [messageServerA1Id, messageServerA2Id, messageServerB1Id]
      );

      // Server A should only see its own message_servers (A1, A2)
      // Server B's message_server (B1) should not be visible due to Server RLS on message_servers table
      expect(result.rows.length).toBeLessThan(3);

      // All visible rows should belong to Server A
      result.rows.forEach((row) => {
        expect([messageServerA1Id, messageServerA2Id]).toContain(row.id);
      });
    });

    it('should have server_isolation_policy applied', async () => {
      // pg_policies is a system catalog, any user can query it
      const result = await serverAClient.query(`
      SELECT policyname, cmd, qual
      FROM pg_policies
      WHERE tablename = 'message_server_agents'
        AND policyname = 'server_isolation_policy'
    `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].qual).toContain('server_id = current_server_id()');
    });

    it('should have server_id column with DEFAULT current_server_id()', async () => {
      // information_schema is accessible by any user
      const result = await serverAClient.query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'message_server_agents'
        AND column_name = 'server_id'
    `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].column_default).toContain('current_server_id()');
    });

    it('should prevent Server A from querying Server B associations even with known UUIDs', async () => {
      // This simulates what getAgentsForMessageServer() does in production
      // Server A tries to query agents for Server B's message server (messageServerB1Id)
      // Even though Server A knows the UUID, RLS should prevent seeing the data

      const result = await serverAClient.query(
        `
      SELECT agent_id
      FROM message_server_agents
      WHERE message_server_id = $1
    `,
        [messageServerB1Id]
      );

      // Server A should see NOTHING because RLS filters by server_id
      expect(result.rows).toHaveLength(0);

      // Verify with Server B that its association exists (same data, different context)
      const serverBResult = await serverBClient.query(
        `
      SELECT agent_id, server_id
      FROM message_server_agents
      WHERE message_server_id = $1
    `,
        [messageServerB1Id]
      );

      expect(serverBResult.rows).toHaveLength(1);
      expect(serverBResult.rows[0].agent_id).toBe(agentBId);
      expect(serverBResult.rows[0].server_id).toBe(serverBId);
    });

    it('should prevent Server B from modifying Server A associations', async () => {
      // Server B tries to delete Server A's association
      await serverBClient.query(
        `
      DELETE FROM message_server_agents
      WHERE message_server_id = $1 AND agent_id = $2
    `,
        [messageServerA1Id, agentAId]
      );

      // Verify with Server A that its association still exists (delete was blocked by RLS)
      const result = await serverAClient.query(
        `
      SELECT *
      FROM message_server_agents
      WHERE message_server_id = $1 AND agent_id = $2
    `,
        [messageServerA1Id, agentAId]
      );

      expect(result.rows.length).toBeGreaterThan(0);
    });
  }
);
