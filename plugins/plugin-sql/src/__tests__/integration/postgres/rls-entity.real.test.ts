/**
 * PostgreSQL RLS entity-isolation integration tests against a real Postgres
 * with RLS enabled (`docker-compose up -d postgres`). Verifies entity-level
 * isolation (user privacy), participant-based access control (room
 * membership), Entity RLS composing with Server RLS (double isolation), and
 * that `PostgresConnectionManager.withEntityContext()` sets the RLS entity
 * context via the parameterized, transaction-scoped
 * `set_config('app.entity_id', $1, true)` form — this exercises the real
 * production code path, not a raw-interpolation stand-in.
 */
import { MemoryType, stringToUuid, type UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabaseAdapter } from "../../../pg/adapter";
import { PostgresConnectionManager } from "../../../pg/manager";
import { bootstrapPostgresRlsSchema, toPostgresSuperuserUrl } from "./rls-test-helpers";

// Skip these tests if POSTGRES_URL is not set (e.g., in CI without PostgreSQL)
describe.skipIf(!process.env.POSTGRES_URL)("PostgreSQL RLS Entity Integration", () => {
  let setupClient: Client; // Setup client for migrations (eliza_test user)
  let superuserClient: Client; // Superuser client for data setup (bypasses RLS)
  let manager: PostgresConnectionManager; // Production code path for RLS tests

  const POSTGRES_URL =
    process.env.POSTGRES_URL || "postgresql://eliza_test:test123@localhost:5432/eliza_test";
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
  const room1DocumentId = uuidv4();
  const room2DocumentId = uuidv4();

  beforeAll(async () => {
    await bootstrapPostgresRlsSchema(POSTGRES_URL);

    setupClient = new Client({
      connectionString: POSTGRES_URL,
      application_name: serverId,
    });
    await setupClient.connect();

    superuserClient = new Client({
      connectionString: toPostgresSuperuserUrl(POSTGRES_URL),
      application_name: serverId,
    });
    await superuserClient.connect();

    // Create PostgresConnectionManager for test assertions
    // This tests the actual production code path (withEntityContext + sql.raw fix)
    manager = new PostgresConnectionManager(POSTGRES_URL, serverId);

    // Enable data isolation for these tests (required for withEntityContext to set entity context)
    process.env.ENABLE_DATA_ISOLATION = "true";

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

    // Create entities (server_id is added dynamically by RLS)
    try {
      const result = await superuserClient.query(
        `INSERT INTO entities (id, agent_id, names, metadata, created_at)
         VALUES
           ($1, $4, ARRAY['Alice'], '{}'::jsonb, NOW()),
           ($2, $4, ARRAY['Bob'], '{}'::jsonb, NOW()),
           ($3, $4, ARRAY['Charlie'], '{}'::jsonb, NOW()),
           ($4, $4, ARRAY['Agent'], '{}'::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET names = EXCLUDED.names
         RETURNING id`,
        [aliceId, bobId, charlieId, agentId]
      );
      console.log("[RLS Test] Entities created:", result.rows.length);
    } catch (err) {
      console.error(
        "[RLS Test] Failed to create entities:",
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }

    // Create rooms (server_id is added dynamically by RLS)
    await superuserClient.query(
      `INSERT INTO rooms (id, agent_id, source, type, created_at)
       VALUES
         ($1, $3, 'test', 'DM', NOW()),
         ($2, $3, 'test', 'GROUP', NOW())
       ON CONFLICT (id) DO NOTHING`,
      [room1Id, room2Id, agentId]
    );

    // Create human participants only. createRoom() does not make the agent a
    // participant, so privileged document reads must use the document-specific
    // RLS branch rather than relying on a fixture-only membership invariant.
    try {
      const participantResult = await superuserClient.query(
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
        "[RLS Test] Participants created:",
        participantResult.rows.length,
        participantResult.rows.map((r: { entity_id?: string }) => ({
          e: r.entity_id?.substring(0, 8),
        }))
      );
    } catch (err) {
      console.error(
        "[RLS Test] Failed to create participants:",
        err instanceof Error ? err.message : String(err)
      );
      console.log("UUIDs:", {
        aliceId,
        bobId,
        charlieId,
        room1Id,
        room2Id,
        agentId,
      });
      throw err;
    }

    // Create memories (server_id is added dynamically by RLS)
    // Memory in room1 (accessible to Alice and Bob)
    await superuserClient.query(
      `INSERT INTO memories (id, agent_id, room_id, content, type, created_at)
       VALUES (gen_random_uuid(), $1, $2, '{"text": "Message in room1"}', 'message', NOW())`,
      [agentId, room1Id]
    );

    // Memory in room2 (accessible to Bob and Charlie)
    await superuserClient.query(
      `INSERT INTO memories (id, agent_id, room_id, content, type, created_at)
       VALUES (gen_random_uuid(), $1, $2, '{"text": "Message in room2"}', 'message', NOW())`,
      [agentId, room2Id]
    );
    console.log("[RLS Test] Test data setup complete");
  }, 120_000);

  afterAll(async () => {
    // Cleanup using superuser (bypasses RLS)
    try {
      await superuserClient.query(`DELETE FROM memories WHERE room_id IN ($1, $2)`, [
        room1Id,
        room2Id,
      ]);
      await superuserClient.query(`DELETE FROM participants WHERE room_id IN ($1, $2)`, [
        room1Id,
        room2Id,
      ]);
      await superuserClient.query(`DELETE FROM rooms WHERE id IN ($1, $2)`, [room1Id, room2Id]);
      await superuserClient.query(`DELETE FROM entities WHERE id IN ($1, $2, $3, $4)`, [
        aliceId,
        bobId,
        charlieId,
        agentId,
      ]);
      await superuserClient.query(`DELETE FROM agents WHERE id = $1`, [agentId]);
      await superuserClient.query(`DELETE FROM servers WHERE id = $1`, [serverId]);
    } catch (err) {
      console.warn("[RLS Test] Cleanup error:", err);
    }

    await setupClient.end();
    await superuserClient.end();
    await manager.close();
  });

  it("should block access without entity context", async () => {
    // Without entity context, user should see 0 memories (STRICT mode)
    // Use withEntityContext with null to test no entity context
    const result = await manager.withEntityContext(null, async (tx) => {
      return await tx.execute(sql`SELECT COUNT(*) as count FROM memories`);
    });

    expect(parseInt(String(result.rows[0].count), 10)).toBe(0);
  });

  it("should allow Alice to see room1 memories (tests withEntityContext + sql.raw fix)", async () => {
    // Exercises the production path: withEntityContext() ->
    // sql.raw(`SET LOCAL app.entity_id = '${entityId}'`).
    const result = await manager.withEntityContext(aliceId as UUID, async (tx) => {
      return await tx.execute(sql`SELECT id, room_id, content FROM memories`);
    });

    // Alice is in room1, so should see 1 memory
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].room_id).toBe(room1Id);
    expect((result.rows[0].content as { text: string }).text).toContain("room1");
  });

  it("should allow Bob to see BOTH room1 and room2 memories", async () => {
    const result = await manager.withEntityContext(bobId as UUID, async (tx) => {
      return await tx.execute(sql`SELECT id, room_id, content FROM memories ORDER BY room_id`);
    });

    // Bob is in both rooms, so should see 2 memories
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r: { room_id: string }) => r.room_id)).toContain(room1Id);
    expect(result.rows.map((r: { room_id: string }) => r.room_id)).toContain(room2Id);
  });

  it("keeps document role visibility within real PostgreSQL room RLS", async () => {
    await superuserClient.query(
      `INSERT INTO memories (
         id, agent_id, entity_id, room_id, content, type, metadata, created_at
       )
       VALUES
         ($1, $3, $3, $4, '{"text": "Document in room1"}', 'documents',
          '{"type":"document","timestamp":1000,"scope":"global"}'::jsonb, NOW()),
         ($2, $3, $3, $5, '{"text": "Document in room2"}', 'documents',
          '{"type":"document","timestamp":1000,"scope":"global"}'::jsonb, NOW())`,
      [room1DocumentId, room2DocumentId, agentId, room1Id, room2Id]
    );
    try {
      const adapter = new PgDatabaseAdapter(agentId as UUID, manager);
      const base = {
        agentId: agentId as UUID,
        requesterRole: "USER" as const,
        limit: 10,
        offset: 0,
      };
      const aliceRooms = await adapter.getRoomsForParticipants([aliceId as UUID]);
      const bobRooms = await adapter.getRoomsForParticipants([bobId as UUID]);

      const alice = await adapter.queryDocuments({
        ...base,
        requesterEntityId: aliceId as UUID,
        requesterRoomIds: [room1Id as UUID],
      });
      const bob = await adapter.queryDocuments({
        ...base,
        requesterEntityId: bobId as UUID,
        requesterRoomIds: [room1Id as UUID, room2Id as UUID],
      });
      const aliceOwner = await adapter.queryDocuments({
        ...base,
        requesterEntityId: aliceId as UUID,
        requesterRoomIds: [],
        requesterRole: "OWNER",
      });
      const runtime = await adapter.queryDocuments({
        ...base,
        requesterEntityId: agentId as UUID,
        requesterRoomIds: [],
        requesterRole: "RUNTIME",
      });
      const agent = await adapter.queryDocuments({
        ...base,
        requesterEntityId: agentId as UUID,
        requesterRoomIds: [],
        requesterRole: "AGENT",
      });

      expect(alice.documents.map((memory) => memory.id)).toEqual([room1DocumentId]);
      expect(bob.documents.map((memory) => memory.id).sort()).toEqual(
        [room1DocumentId, room2DocumentId].sort()
      );
      expect(aliceOwner.documents.map((memory) => memory.id).sort()).toEqual(
        [room1DocumentId, room2DocumentId].sort()
      );
      expect(runtime.documents.map((memory) => memory.id).sort()).toEqual(
        [room1DocumentId, room2DocumentId].sort()
      );
      expect(agent.documents.map((memory) => memory.id).sort()).toEqual(
        [room1DocumentId, room2DocumentId].sort()
      );
      expect(aliceRooms).toEqual([room1Id]);
      expect(bobRooms.sort()).toEqual([room1Id, room2Id].sort());
      expect(alice.totalVisible).toBe(1);
      expect(bob.totalVisible).toBe(2);
      expect(aliceOwner.totalVisible).toBe(2);
      expect(runtime.totalVisible).toBe(2);
      expect(agent.totalVisible).toBe(2);
      expect(alice.documents[0]?.metadata?.type).toBe(MemoryType.DOCUMENT);
    } finally {
      await superuserClient.query(`DELETE FROM memories WHERE id IN ($1, $2)`, [
        room1DocumentId,
        room2DocumentId,
      ]);
    }
  });

  it("should allow Charlie to see ONLY room2 memories", async () => {
    const result = await manager.withEntityContext(charlieId as UUID, async (tx) => {
      return await tx.execute(sql`SELECT id, room_id, content FROM memories`);
    });

    // Charlie is only in room2
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].room_id).toBe(room2Id);
    expect((result.rows[0].content as { text: string }).text).toContain("room2");
  });

  it("should block non-participant from seeing any memories", async () => {
    const nonParticipantId = uuidv4();

    const result = await manager.withEntityContext(nonParticipantId as UUID, async (tx) => {
      return await tx.execute(sql`SELECT COUNT(*) as count FROM memories`);
    });

    // Non-participant should see 0
    expect(parseInt(String(result.rows[0].count), 10)).toBe(0);
  });

  it("should have entity_isolation_policy on key tables", async () => {
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

  it("should use current_entity_id() function correctly via withEntityContext", async () => {
    const result = await manager.withEntityContext(aliceId as UUID, async (tx) => {
      return await tx.execute(sql`SELECT current_entity_id() as eid`);
    });

    expect(result.rows[0].eid).toBe(aliceId);
  });

  it("should combine Server RLS + Entity RLS (double isolation)", async () => {
    // Create a manager with wrong server context
    const wrongServerId = uuidv4();
    const wrongServerManager = new PostgresConnectionManager(POSTGRES_URL, wrongServerId);

    try {
      // Even with correct entity_id, wrong server_id should see nothing
      const result = await wrongServerManager.withEntityContext(aliceId as UUID, async (tx) => {
        return await tx.execute(sql`SELECT COUNT(*) as count FROM memories`);
      });

      // Wrong server context blocks access
      expect(parseInt(String(result.rows[0].count), 10)).toBe(0);
    } finally {
      await wrongServerManager.close();
    }
  });
});
