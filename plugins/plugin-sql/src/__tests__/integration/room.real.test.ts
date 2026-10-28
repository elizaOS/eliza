/**
 * Room-store CRUD tests against a real PGlite (or Postgres, if `POSTGRES_URL`
 * is set) adapter via `createIsolatedTestDatabase` — no mocks.
 */
import {
  type AgentRuntime,
  authorizeManageServerDestination,
  ChannelType,
  type Room,
  type UUID,
} from "@elizaos/core";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { roomTable } from "../../schema/room";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Room Integration Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let _runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testWorldId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("room-tests");
    adapter = setup.adapter;
    _runtime = setup.runtime;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    testWorldId = uuidv4() as UUID;
    await adapter.createWorld({
      id: testWorldId,
      agentId: testAgentId,
      name: "Test World",
      messageServerId: uuidv4() as UUID,
    });
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("Room Tests", () => {
    beforeEach(async () => {
      const db = adapter.getDatabase() as {
        delete: (table: typeof roomTable) => Promise<void>;
      };
      await db.delete(roomTable);
    });

    it("should create and retrieve a room", async () => {
      const roomId = uuidv4() as UUID;
      const room: Room = {
        id: roomId,
        agentId: testAgentId,
        worldId: testWorldId,
        source: "test",
        type: ChannelType.GROUP,
        name: "Test Room",
      };
      await adapter.createRooms([room]);
      const retrieved = await adapter.getRoomsByIds([roomId]);
      expect(retrieved).not.toBeNull();
      if (!retrieved?.[0]) throw new Error("Room should exist");
      expect(retrieved[0].id).toBe(roomId);
    });

    it("should get all rooms for a world", async () => {
      const room1: Room = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        worldId: testWorldId,
        source: "test",
        type: ChannelType.GROUP,
        name: "Room 1",
      };
      const room2: Room = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        worldId: testWorldId,
        source: "test",
        type: ChannelType.GROUP,
        name: "Room 2",
      };
      await adapter.createRooms([room1, room2]);
      const rooms = await adapter.getRoomsByWorld(testWorldId);
      expect(rooms).toHaveLength(2);
    });

    it("applies zero and positive limits in getRoomsByWorlds", async () => {
      const rooms: Room[] = ["Room 1", "Room 2", "Room 3"].map((name) => ({
        id: uuidv4() as UUID,
        agentId: testAgentId,
        worldId: testWorldId,
        source: "test",
        type: ChannelType.GROUP,
        name,
      }));
      await adapter.createRooms(rooms);

      expect(await adapter.getRoomsByWorlds([testWorldId])).toHaveLength(3);
      expect(await adapter.getRoomsByWorlds([testWorldId], 0, 0)).toEqual([]);
      expect(await adapter.getRoomsByWorlds([testWorldId], 1, 0)).toHaveLength(1);
      expect(await adapter.getRoomsByWorlds([testWorldId], 1, 1)).toHaveLength(1);
    });

    it("should update a room", async () => {
      const roomId = uuidv4() as UUID;
      const room = {
        id: roomId,
        agentId: testAgentId,
        worldId: testWorldId,
        source: "test",
        type: ChannelType.GROUP,
        name: "Original Room Name",
      };
      await adapter.createRooms([room as Room]);

      const updatedRoom = { ...room, name: "Updated Room Name" };
      await adapter.updateRoom(updatedRoom);

      const retrieved = await adapter.getRoomsByIds([roomId]);
      expect(retrieved).not.toBeNull();
      if (!retrieved?.[0]) throw new Error("Room should exist");
      expect(retrieved[0].name).toBe("Updated Room Name");
    });

    it("should delete a room", async () => {
      const roomId = uuidv4() as UUID;
      const room = {
        id: roomId,
        agentId: testAgentId,
        worldId: testWorldId,
        source: "test",
        type: ChannelType.GROUP,
        name: "To Be Deleted",
      };
      await adapter.createRooms([room as Room]);

      let retrieved = await adapter.getRoomsByIds([room.id]);
      expect(retrieved).toHaveLength(1);

      await adapter.deleteRoom(room.id);

      retrieved = await adapter.getRoomsByIds([room.id]);
      expect(retrieved).toEqual([]);
    });

    it("should store and retrieve messageServerId", async () => {
      const roomId = uuidv4() as UUID;
      const messageServerId = uuidv4() as UUID;
      const room: Room = {
        id: roomId,
        agentId: testAgentId,
        worldId: testWorldId,
        source: "discord",
        type: ChannelType.GROUP,
        name: "Discord Room",
        messageServerId: messageServerId,
      };

      await adapter.createRooms([room]);
      const retrieved = await adapter.getRoomsByIds([roomId]);

      expect(retrieved).toHaveLength(1);
      if (!retrieved?.[0]) throw new Error("Room should exist");
      expect(retrieved[0].messageServerId).toBe(messageServerId);
    });

    it("should preserve the connector serverId through runtime room persistence", async () => {
      const roomId = uuidv4() as UUID;
      const messageServerId = uuidv4() as UUID;
      const serverId = "123456789012345678";

      await _runtime.ensureRoomExists({
        id: roomId,
        agentId: testAgentId,
        worldId: testWorldId,
        source: "discord",
        type: ChannelType.GROUP,
        name: "Discord Guild Room",
        channelId: "987654321098765432",
        serverId,
        messageServerId,
        metadata: { accountId: "work" },
      });

      const retrieved = await adapter.getRoomsByIds([roomId]);
      const stored = await (adapter.getDatabase() as DrizzleDatabase)
        .select({ serverId: roomTable.serverId })
        .from(roomTable)
        .where(eq(roomTable.id, roomId));

      expect(retrieved).toHaveLength(1);
      expect(retrieved[0]?.serverId).toBe(serverId);
      expect(retrieved[0]?.messageServerId).toBe(messageServerId);
      expect(retrieved[0]?.metadata).toMatchObject({ accountId: "work" });
      expect(retrieved[0]?.metadata).not.toHaveProperty("serverId");
      expect(stored[0]?.serverId).toBe(serverId);
    });

    it("should keep a room's stored channel and name when a connection omits them", async () => {
      const roomId = uuidv4() as UUID;
      const entityId = uuidv4() as UUID;
      if (!(await adapter.getEntitiesByIds([testAgentId]))?.length) {
        await adapter.createEntities([
          { id: testAgentId, agentId: testAgentId, names: ["Test Agent"] },
        ]);
      }

      await _runtime.ensureRoomExists({
        id: roomId,
        agentId: testAgentId,
        worldId: testWorldId,
        source: "x",
        type: ChannelType.DM,
        name: "X DM with @alice",
        channelId: "111-999",
      });
      await _runtime.ensureConnection({
        entityId,
        roomId,
        worldId: testWorldId,
        source: "x",
        type: ChannelType.DM,
        userName: "alice",
        name: "Alice",
      });

      const retrieved = await adapter.getRoomsByIds([roomId]);
      expect(retrieved?.[0]?.channelId).toBe("111-999");
      expect(retrieved?.[0]?.name).toBe("X DM with @alice");
    });

    it("should authorize manage_server for a room written through ensureConnection", async () => {
      const roomId = uuidv4() as UUID;
      const requesterEntityId = uuidv4() as UUID;
      const serverId = "223456789012345678";
      const world = await adapter.getWorld(testWorldId);
      if (!world?.messageServerId) throw new Error("World should have a message server id");

      await adapter.createEntities([
        {
          id: requesterEntityId,
          agentId: testAgentId,
          names: ["Discord Operator"],
        },
        {
          id: testAgentId,
          agentId: testAgentId,
          names: ["Test Agent"],
        },
      ]);

      await _runtime.ensureConnection({
        entityId: requesterEntityId,
        roomId,
        worldId: testWorldId,
        source: "discord",
        type: ChannelType.GROUP,
        channelId: "323456789012345678",
        serverId,
        messageServerId: world.messageServerId,
      });

      const connectedWorld = await adapter.getWorld(testWorldId);
      if (!connectedWorld) throw new Error("Connected world should exist");
      await adapter.updateWorld({
        ...connectedWorld,
        metadata: {
          ...connectedWorld.metadata,
          roles: { [requesterEntityId]: "ADMIN" },
          roleSources: { [requesterEntityId]: "manual" },
        },
      });

      const authorization = await authorizeManageServerDestination(_runtime, requesterEntityId, {
        source: "discord",
        accountId: "work",
        serverId,
        messageServerId: world.messageServerId,
        destinationWorldId: testWorldId,
        target: {
          source: "discord",
          channelId: "323456789012345678",
          serverId,
        },
      });

      expect(authorization).toMatchObject({
        requesterEntityId,
        authorizedEntityId: requesterEntityId,
        role: "ADMIN",
        bindingRoomIds: [roomId],
      });
    });
  });
});
