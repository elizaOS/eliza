/** Real PostgreSQL/RLS proof for authorized legacy-content reindex (#25140). */
import type { Memory, UUID } from "@elizaos/core";
import { Client } from "pg";
import { v4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgDatabaseAdapter } from "../../../pg/adapter";
import { PostgresConnectionManager } from "../../../pg/manager";
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
});
