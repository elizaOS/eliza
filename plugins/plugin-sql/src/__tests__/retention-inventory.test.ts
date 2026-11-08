/**
 * Pins the id-only retention inventory against a real isolated PGlite (or
 * Postgres) adapter: keyset pages newest-first across rows that share one
 * millisecond, excluded log types never come back, and each table is scoped
 * to its partition. No mocks.
 */
import { ChannelType, type Entity, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../pg/adapter";
import type { PgliteDatabaseAdapter } from "../pglite/adapter";
import { createIsolatedTestDatabase } from "./test-helpers";

describe("getRetentionInventory", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let roomId: UUID;
  let entityId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("retention-inventory");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
    roomId = uuidv4() as UUID;
    entityId = uuidv4() as UUID;
    await adapter.createEntities([
      { id: entityId, agentId: testAgentId, names: ["writer"] } as Entity,
    ]);
    await adapter.createRooms([
      { id: roomId, agentId: testAgentId, source: "test", type: ChannelType.DM },
    ]);
  });

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  async function walk(params: {
    table: "logs" | "memories";
    partition?: string;
    excludeTypes?: string[];
  }) {
    const pages: number[] = [];
    const seen: { id: UUID; createdAt: number }[] = [];
    let cursor: { createdAt: number; id: UUID } | undefined;
    for (;;) {
      const page = await adapter.getRetentionInventory({ ...params, cursor, limit: 2 });
      pages.push(page.length);
      seen.push(...page.map(({ id, createdAt }) => ({ id, createdAt })));
      if (page.length < 2) break;
      const last = page[page.length - 1];
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    return { pages, seen };
  }

  it("pages logs newest-first through millisecond ties and leaves out excluded types", async () => {
    const tie = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 5));
    await adapter.createLogs([
      ...Array.from({ length: 4 }, (_, index) => ({
        entityId,
        roomId,
        type: "lifecycle",
        body: { index },
        createdAt: tie,
      })),
      {
        entityId,
        roomId,
        type: "lifecycle",
        body: { index: 4 },
        createdAt: new Date(tie.getTime() + 1),
      },
      { entityId, roomId, type: "audit", body: {}, createdAt: new Date(tie.getTime() - 1) },
    ]);

    const { pages, seen } = await walk({ table: "logs", excludeTypes: ["audit"] });
    expect(pages).toEqual([2, 2, 1]);
    expect(seen).toHaveLength(5);
    expect(new Set(seen.map((row) => row.id)).size).toBe(5);
    expect(seen[0].createdAt).toBe(tie.getTime() + 1);
    expect(seen.slice(1).every((row) => row.createdAt === tie.getTime())).toBe(true);
    const tied = seen.slice(1).map((row) => row.id);
    expect(tied).toEqual([...tied].sort().reverse());
    const audit = await adapter.getLogs({ type: "audit", limit: 10 });
    expect(seen.some((row) => row.id === audit[0].id)).toBe(false);
  });

  it("scopes memories to one partition and returns rows without a room", async () => {
    const base = Date.UTC(2026, 0, 2);
    const messageIds: UUID[] = [];
    for (let index = 0; index < 3; index++) {
      const id = uuidv4() as UUID;
      messageIds.push(id);
      await adapter.createMemories([
        {
          tableName: "messages",
          memory: {
            id,
            entityId,
            agentId: testAgentId,
            roomId: index === 0 ? (undefined as unknown as UUID) : roomId,
            createdAt: base + index,
            content: { text: `message ${index}` },
          },
        },
      ]);
    }
    await adapter.createMemories([
      {
        tableName: "facts",
        memory: {
          id: uuidv4() as UUID,
          entityId,
          agentId: testAgentId,
          roomId,
          createdAt: base + 10,
          content: { text: "a fact" },
        },
      },
    ]);

    const page = await adapter.getRetentionInventory({
      table: "memories",
      partition: "messages",
      limit: 10,
    });
    expect(page.map((row) => row.id)).toEqual([...messageIds].reverse());
    expect(page.map((row) => row.createdAt)).toEqual([base + 2, base + 1, base]);
    expect(page[2].roomId).toBeNull();
    expect(page[0].roomId).toBe(roomId);
  });
});
