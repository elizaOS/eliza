/** Real PostgreSQL/RLS proof for authorized legacy-content reindex (#25140). */
import type { Memory, UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { v4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabaseAdapter } from "../../../pg/adapter";
import { PostgresConnectionManager } from "../../../pg/manager";
import { reindexMemoryContent as reindexMemoryContentInTransaction } from "../../../stores/memoryTextSegments.store";
import { bootstrapPostgresRlsSchema, toPostgresSuperuserUrl } from "./rls-test-helpers";

describe.skipIf(!process.env.POSTGRES_URL)("memory content paging PostgreSQL RLS", () => {
  const connectionString = process.env.POSTGRES_URL!;
  const serverId = v4() as UUID;
  const agentId = v4() as UUID;
  const entityId = v4() as UUID;
  const roomId = v4() as UUID;
  const memoryId = v4() as UUID;
  let manager: PostgresConnectionManager;
  let adapter: PgDatabaseAdapter;
  let superuser: Client;

  beforeAll(async () => {
    await bootstrapPostgresRlsSchema(connectionString);
    process.env.ENABLE_DATA_ISOLATION = "true";
    manager = new PostgresConnectionManager(connectionString, serverId);
    adapter = new PgDatabaseAdapter(agentId, manager);
    await adapter.init();
    await adapter.createAgent({
      id: agentId,
      name: "paging-rules",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await adapter.createRooms([{ id: roomId, agentId, source: "test", type: "direct" as never }]);
    await adapter.createEntities([{ id: entityId, agentId, names: ["reader"] }]);
    superuser = new Client({ connectionString: toPostgresSuperuserUrl(connectionString) });
    await superuser.connect();
    await superuser.query(
      "INSERT INTO participants (entity_id, room_id, agent_id, server_id) VALUES ($1, $2, $3, $4)",
      [entityId, roomId, agentId, serverId]
    );
    await adapter.createMemory(
      {
        id: memoryId,
        agentId,
        entityId,
        roomId,
        content: { text: "seed", source: "test" },
      } as Memory,
      "messages"
    );
    await superuser.query(
      "UPDATE memories SET content = jsonb_build_object('text', repeat('x', 1048576), 'source', 'legacy') WHERE id = $1",
      [memoryId]
    );
  });

  afterAll(async () => {
    await superuser?.end();
    await adapter?.close();
    await manager?.close();
    delete process.env.ENABLE_DATA_ISOLATION;
  });

  it("denies the wrong room and reauthorizes every page for the right room", async () => {
    const base = { requesterEntityId: entityId, role: "USER" as const };
    await expect(
      adapter.reindexMemoryContent({
        memoryId,
        field: { kind: "content.text" },
        accessContext: { ...base, authorizedRoomIds: [v4() as UUID] },
        maxSourceBytes: 2 * 1024 * 1024,
      })
    ).rejects.toMatchObject({ code: "MEMORY_CONTENT_REINDEX_NOT_AUTHORIZED" });

    const receipt = await adapter.reindexMemoryContent({
      memoryId,
      field: { kind: "content.text" },
      accessContext: { ...base, authorizedRoomIds: [roomId] },
      maxSourceBytes: 2 * 1024 * 1024,
    });
    expect(receipt.totalBytes).toBe(1024 * 1024);
    const page = await adapter.getMemoryContentPage({
      memoryId,
      field: { kind: "content.text" },
      byteStart: 0,
      accessContext: { ...base, authorizedRoomIds: [roomId] },
    });
    expect(page?.sourceSha256).toBe(receipt.sourceSha256);
    expect(page?.text.length).toBeGreaterThan(0);
    await expect(
      adapter.getMemoryContentPage({
        memoryId,
        field: { kind: "content.text" },
        byteStart: page!.end,
        expectedRevision: receipt.revision,
        accessContext: { ...base, authorizedRoomIds: [v4() as UUID] },
      })
    ).resolves.toBeNull();
  });

  it("opens the entity context at repeatable read for snapshot-safe paging", async () => {
    const isolation = await manager.withEntityContext(
      entityId,
      async (tx) => {
        const result = await tx.execute(sql`SHOW transaction_isolation`);
        return (result.rows as Array<{ transaction_isolation: string }>)[0]?.transaction_isolation;
      },
      { isolationLevel: "repeatable read" }
    );

    expect(isolation).toBe("repeatable read");
  });

  it("rolls back segments when authorization changes before parent publication", async () => {
    const revocationMemoryId = v4() as UUID;
    await adapter.createMemory(
      {
        id: revocationMemoryId,
        agentId,
        entityId,
        roomId,
        content: { text: "seed", source: "test" },
      } as Memory,
      "messages"
    );
    await superuser.query(
      "UPDATE memories SET content = jsonb_build_object('text', repeat('r', 1048576), 'source', 'legacy') WHERE id = $1",
      [revocationMemoryId]
    );
    await superuser.query("DROP SEQUENCE IF EXISTS reindex_authz_calls");
    await superuser.query("CREATE SEQUENCE reindex_authz_calls START 1");
    await superuser.query("GRANT USAGE, SELECT ON SEQUENCE reindex_authz_calls TO PUBLIC");

    await expect(
      manager.withEntityContext(
        entityId,
        (tx) =>
          reindexMemoryContentInTransaction({
            db: tx,
            memoryId: revocationMemoryId,
            field: { kind: "content.text" },
            maxSourceBytes: 2 * 1024 * 1024,
            // The first two authorized reads succeed; publication observes
            // the simulated revocation and must abort before inserting rows.
            parentAuthorization: sql`nextval('reindex_authz_calls') <= 2`,
          }),
        { isolationLevel: "repeatable read" }
      )
    ).rejects.toMatchObject({ code: "MEMORY_CONTENT_REINDEX_NOT_AUTHORIZED" });

    const persisted = await superuser.query<{
      segment_count: string;
      text_bytes: number;
    }>(
      `SELECT
         (SELECT count(*) FROM memory_text_segments WHERE parent_id = $1) AS segment_count,
         octet_length(content->>'text') AS text_bytes
       FROM memories WHERE id = $1`,
      [revocationMemoryId]
    );
    expect(persisted.rows[0]).toEqual({ segment_count: "0", text_bytes: 1024 * 1024 });
    await superuser.query("DROP SEQUENCE reindex_authz_calls");
  });
});
