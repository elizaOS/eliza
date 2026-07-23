/**
 * Concurrency regression for the warm-turn chat fast lane.
 *
 * The conversation route's user-message persist and the message pipeline's
 * ingress persist share the SAME memory id. Running them concurrently (which
 * the warm-turn fast lane in packages/agent/src/api/conversation-routes.ts now
 * does — pre-model room-ensure + user persist race the model call) fires two
 * `createMemory` calls for one id at once. base `createMemory` guards the
 * common case with a `getMemoryById` check, but that check-then-insert is a
 * TOCTOU: under true concurrency both writers can observe no row and both reach
 * the INSERT. This proves the INSERT is idempotent on the `id` primary key
 * (ON CONFLICT DO NOTHING) so exactly one row lands and neither writer throws —
 * structural, not sleep/retry based.
 */
import {
  ChannelType,
  type Content,
  type Entity,
  type Memory,
  type MemoryMetadata,
  MemoryType,
  type Room,
  type UUID,
  type World,
} from "@elizaos/core";
import { eq } from "drizzle-orm";
import { v4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { embeddingTable, memoryTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Memory concurrent-persist idempotency", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testRoomId: UUID;
  let testEntityId: UUID;
  let testWorldId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("memory_concurrent_persist");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    testRoomId = v4() as UUID;
    testEntityId = v4() as UUID;
    testWorldId = v4() as UUID;

    await adapter.createWorld({
      id: testWorldId,
      agentId: testAgentId,
      name: "Test World",
      serverId: "test-server",
    } as World);
    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        worldId: testWorldId,
        name: "Test Room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.createEntities([
      {
        id: testEntityId,
        agentId: testAgentId,
        names: ["Test Entity"],
      } as Entity,
    ]);
    await adapter.addParticipant(testEntityId, testRoomId);
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  beforeEach(async () => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    await db.delete(embeddingTable);
    await db.delete(memoryTable);
  });

  const makeMemory = (id: UUID, content: Content): Memory & { metadata: MemoryMetadata } => ({
    id,
    agentId: testAgentId,
    roomId: testRoomId,
    entityId: testEntityId,
    content,
    createdAt: Date.now(),
    unique: false,
    metadata: { type: MemoryType.MESSAGE, source: "test" },
  });

  const rowCountForId = async (id: UUID): Promise<number> => {
    const db = adapter.getDatabase() as DrizzleDatabase;
    const rows = await db.select().from(memoryTable).where(eq(memoryTable.id, id));
    return rows.length;
  };

  it("two same-id createMemory calls racing produce exactly one row and neither throws", async () => {
    const id = v4() as UUID;
    // Distinct content mirrors the route (messageToStore) vs pipeline
    // (ingress) shapes that share one id but differ (e.g. compacted
    // attachments). Whichever wins the race, exactly one row must remain.
    const routeSide = makeMemory(id, { text: "hello", source: "route" });
    const pipelineSide = makeMemory(id, { text: "hello", source: "pipeline" });

    const results = await Promise.allSettled([
      adapter.createMemory(routeSide, "messages"),
      adapter.createMemory(pipelineSide, "messages"),
    ]);

    // Neither concurrent writer may reject (no duplicate-PK throw escaping).
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
      if (r.status === "fulfilled") expect(r.value).toBe(id);
    }

    // Exactly one physical row for that id.
    expect(await rowCountForId(id)).toBe(1);

    const retrieved = await adapter.getMemoryById(id);
    expect(retrieved).toBeTruthy();
    expect(retrieved?.id).toBe(id);
  });

  it("a same-id create after an existing row is a no-op, not a throw", async () => {
    const id = v4() as UUID;
    const first = await adapter.createMemory(
      makeMemory(id, { text: "first", source: "route" }),
      "messages"
    );
    expect(first).toBe(id);

    // Serial second write on the committed row: the getMemoryById guard
    // short-circuits, but even if it did not the INSERT must not raise.
    const second = await adapter.createMemory(
      makeMemory(id, { text: "second", source: "pipeline" }),
      "messages"
    );
    expect(second).toBe(id);

    expect(await rowCountForId(id)).toBe(1);
  });
});
