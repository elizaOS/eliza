/** Verifies real PGlite participant batching, SQL query count, and complete per-room results. */
import { randomUUID } from "node:crypto";
import { ChannelType, type UUID } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { expect, it } from "vitest";
import { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { createIsolatedTestDatabase } from "../test-helpers";

it("reads participants once while preserving requested order, duplicate rooms, and empty rooms", async () => {
  const setup = await createIsolatedTestDatabase("participant-batch", [], { postgresUrl: null });
  const { adapter, runtime, testAgentId: agentId } = setup;
  try {
    if (!(adapter instanceof PgliteDatabaseAdapter)) throw new Error("Expected isolated PGlite");
    const entities = Array.from({ length: 3 }, () => randomUUID() as UUID);
    await adapter.createEntities(entities.map((id) => ({ id, agentId, names: [id] })));
    const rooms = Array.from({ length: 12 }, () => ({
      id: randomUUID() as UUID,
      source: "batch-test",
      type: ChannelType.GROUP,
    }));
    await adapter.createRooms(rooms);
    for (const [index, room] of rooms.entries()) {
      if (index !== 0)
        await adapter.createRoomParticipants(entities.slice(0, (index % 3) + 1), room.id);
    }
    const missing = randomUUID() as UUID;
    const requested = [
      ...rooms.map((room) => room.id).reverse(),
      rooms[5].id,
      rooms[5].id.toUpperCase() as UUID,
      missing,
    ];
    const expected = await Promise.all(
      requested.map(async (roomId) => ({
        roomId,
        entityIds: await adapter.getParticipantsForRoom(roomId),
      }))
    );
    const queries: string[] = [];
    adapter.db = drizzle(adapter.getRawConnection(), {
      logger: {
        logQuery(query) {
          queries.push(query);
        },
      },
    });
    const actual = await adapter.getParticipantsForRooms(requested);
    const normalize = (rows: typeof actual) =>
      rows.map((row) => ({ ...row, entityIds: [...row.entityIds].sort() }));
    expect(normalize(actual)).toEqual(normalize(expected));
    expect(
      queries.filter((query) => /^select\b/i.test(query) && query.includes('"participants"'))
    ).toHaveLength(1);
    queries.length = 0;
    expect(await adapter.getParticipantsForRooms([])).toEqual([]);
    expect(queries).toEqual([]);
  } finally {
    await runtime.stop();
    await setup.cleanup();
  }
});
