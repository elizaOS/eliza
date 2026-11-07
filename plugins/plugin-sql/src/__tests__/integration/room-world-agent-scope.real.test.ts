/** Two agent adapters share real PGlite; foreign operations cannot take ownership or delete data. */
import { randomUUID } from "node:crypto";
import { ChannelType, type UUID } from "@elizaos/core";
import { expect, it } from "vitest";
import { DatabaseMigrationService } from "../../migration-service";
import { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { PGliteClientManager } from "../../pglite/manager";
import { schema } from "../../schema";

it("scopes room and world reads, updates and deletes to each adapter", async () => {
  const manager = new PGliteClientManager({ dataDir: "memory://" });
  const ownerId = randomUUID() as UUID;
  const otherId = randomUUID() as UUID;
  const owner = new PgliteDatabaseAdapter(ownerId, manager);
  const other = new PgliteDatabaseAdapter(otherId, manager);
  try {
    await owner.init();
    const migrations = new DatabaseMigrationService();
    await migrations.initializeWithDatabase(owner.db);
    migrations.discoverAndRegisterPluginSchemas([
      { name: "@elizaos/plugin-sql", description: "SQL adapter", schema },
    ]);
    await migrations.runAllPluginMigrations();
    await owner.createAgent({ id: ownerId, name: "Owner" });
    await other.createAgent({ id: otherId, name: "Other" });
    const worldId = randomUUID() as UUID;
    const ownOtherWorld = randomUUID() as UUID;
    await owner.createWorld({ id: worldId, agentId: ownerId, name: "Owner world" });
    await other.createWorld({ id: ownOtherWorld, agentId: otherId, name: "Other world" });
    const room = {
      id: randomUUID() as UUID,
      agentId: ownerId,
      worldId,
      source: "test",
      type: ChannelType.GROUP,
      name: "Owner room",
    };
    await owner.createRooms([room]);
    const entityId = randomUUID() as UUID;
    await owner.createEntities([{ id: entityId, agentId: ownerId, names: ["Owner participant"] }]);
    expect(await owner.addParticipant(entityId, room.id)).toBe(true);
    expect(await owner.getParticipantsForRoom(room.id)).toEqual([entityId]);
    expect(await other.getParticipantsForRoom(room.id)).toEqual([]);
    expect(await other.getParticipantsForRooms([room.id])).toEqual([
      { roomId: room.id, entityIds: [] },
    ]);
    expect(await other.getParticipantsForEntity(entityId)).toEqual([]);
    expect(await other.getRoomsForParticipant(entityId)).toEqual([]);
    expect(await other.getRoomsForParticipants([entityId])).toEqual([]);
    expect(await other.getEntitiesForRoom(room.id)).toEqual([]);
    expect(await other.isRoomParticipant(room.id, entityId)).toBe(false);
    expect(await other.removeParticipant(entityId, room.id)).toBe(false);
    expect(await owner.isRoomParticipant(room.id, entityId)).toBe(true);
    expect(await owner.removeParticipant(entityId, room.id)).toBe(true);
    expect(await owner.getParticipantsForRoom(room.id)).toEqual([]);
    // Hosts derive some world ids without the agent (for example
    // `server:${SERVER_NAME}`), and worlds are keyed by id alone. A second agent
    // must find the existing row, as runtime.ensureWorldExists does, instead of
    // failing on a duplicate insert. It must not take ownership of the row.
    expect((await other.getWorld(worldId))?.agentId).toBe(ownerId);
    expect(
      (await other.getWorldsByIds([worldId, ownOtherWorld])).map((world) => world.id).sort()
    ).toEqual([worldId, ownOtherWorld].sort());
    await other.upsertWorlds([{ id: worldId, agentId: otherId, name: "Foreign rename" }]);
    expect(await owner.getWorld(worldId)).toMatchObject({ agentId: ownerId, name: "Owner world" });
    expect(await other.getRoomsByWorld(worldId)).toEqual([]);
    expect((await owner.getRoomsByWorld(worldId)).map((entry) => entry.id)).toEqual([room.id]);
    await other.updateRoom({ ...room, name: "Foreign rename" });
    expect((await owner.getRoomsByIds([room.id]))?.[0]?.name).toBe("Owner room");
    await other.deleteRoom(room.id);
    expect((await owner.getRoomsByIds([room.id]))?.[0]?.agentId).toBe(ownerId);
    await other.removeWorld(worldId);
    expect((await owner.getWorld(worldId))?.name).toBe("Owner world");
    await other.deleteWorlds([worldId]);
    expect((await owner.getWorld(worldId))?.name).toBe("Owner world");
    await owner.updateRoom({ ...room, name: "Owner rename" });
    expect((await owner.getRoomsByIds([room.id]))?.[0]?.name).toBe("Owner rename");
    await owner.deleteRoom(room.id);
    expect(await owner.getRoomsByWorld(worldId)).toEqual([]);
    await owner.deleteWorlds([worldId]);
    expect(await owner.getWorld(worldId)).toBeNull();
    expect((await other.getWorld(ownOtherWorld))?.name).toBe("Other world");
  } finally {
    await owner.close();
  }
});
