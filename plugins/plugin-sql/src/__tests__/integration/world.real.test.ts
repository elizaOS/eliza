import type { UUID, World } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { worldTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("World Integration Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("world-tests");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("World Tests", () => {
    beforeEach(async () => {
      // Clean up worlds table before each test
      await (adapter.getDatabase() as DrizzleDatabase).delete(worldTable);
    });

    it("should create and retrieve a world", async () => {
      const worldId = uuidv4() as UUID;
      const world: World = {
        id: worldId,
        agentId: testAgentId,
        name: "Test World",
        metadata: { owner: "test-user" },
        messageServerId: "a1111111-1111-4111-8111-111111111111" as UUID,
      };
      await adapter.createWorld(world);

      const retrieved = await adapter.getWorld(worldId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(worldId);
    });

    it("should preserve UUID-shaped server ids outside RFC version constraints", async () => {
      const worldId = uuidv4() as UUID;
      const messageServerId = "06df3cf3-6c0c-0449-9c80-87e36d1ea8f6" as UUID;
      await adapter.createWorld({
        id: worldId,
        agentId: testAgentId,
        name: "Canonical UUID World",
        messageServerId,
      });

      const retrieved = await adapter.getWorld(worldId);
      expect(retrieved?.messageServerId).toBe(messageServerId);
    });

    it("should preserve nil UUID server ids", async () => {
      const worldId = uuidv4() as UUID;
      const messageServerId = "00000000-0000-0000-0000-000000000000" as UUID;
      await adapter.createWorld({
        id: worldId,
        agentId: testAgentId,
        name: "Nil UUID World",
        messageServerId,
      });

      const retrieved = await adapter.getWorld(worldId);
      expect(retrieved?.messageServerId).toBe(messageServerId);
    });

    it("should not create a world with a duplicate id", async () => {
      const worldId = uuidv4() as UUID;
      const world1: World = {
        id: worldId,
        agentId: testAgentId,
        name: "Test World 1",
        messageServerId: "b1111111-1111-4111-8111-111111111111" as UUID,
      };
      const world2: World = {
        id: worldId,
        agentId: testAgentId,
        name: "Test World 2",
        messageServerId: "b2222222-2222-4222-8222-222222222222" as UUID,
      };
      await adapter.createWorld(world1);
      await expect(adapter.createWorld(world2)).rejects.toThrow();
    });

    it("should update an existing world", async () => {
      const worldId = uuidv4() as UUID;
      const originalWorld: World = {
        id: worldId,
        agentId: testAgentId,
        name: "Original World",
        messageServerId: "c1111111-1111-4111-8111-111111111111" as UUID,
      };
      await adapter.createWorld(originalWorld);

      const updatedWorld = { ...originalWorld, name: "Updated World Name" };
      await adapter.updateWorld(updatedWorld);

      const retrieved = await adapter.getWorld(worldId);
      expect(retrieved?.name).toBe("Updated World Name");
    });

    it("should only update the specified world", async () => {
      const world1: World = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        name: "World One",
        messageServerId: "d1111111-1111-4111-8111-111111111111" as UUID,
      };
      const world2: World = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        name: "World Two",
        messageServerId: "d2222222-2222-4222-8222-222222222222" as UUID,
      };
      await adapter.createWorld(world1);
      await adapter.createWorld(world2);

      const updatedWorld1 = { ...world1, name: "Updated World One" };
      await adapter.updateWorld(updatedWorld1);

      const retrieved1 = await adapter.getWorld(world1.id);
      const retrieved2 = await adapter.getWorld(world2.id);
      expect(retrieved1?.name).toBe("Updated World One");
      expect(retrieved2?.name).toBe("World Two");
    });

    it("should delete a world", async () => {
      const worldId = uuidv4() as UUID;
      const world: World = {
        id: worldId,
        agentId: testAgentId,
        name: "To Be Deleted",
        messageServerId: "e1111111-1111-4111-8111-111111111111" as UUID,
      };
      await adapter.createWorld(world);

      let retrieved = await adapter.getWorld(worldId);
      expect(retrieved).not.toBeNull();

      await adapter.removeWorld(worldId);
      retrieved = await adapter.getWorld(worldId);
      expect(retrieved).toBeNull();
    });

    it("should return null when retrieving a non-existent world", async () => {
      const world = await adapter.getWorld(uuidv4() as UUID);
      expect(world).toBeNull();
    });

    it("should retrieve all worlds for an agent", async () => {
      const world1: World = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        name: "World 0",
        messageServerId: "f0000000-0000-4000-8000-000000000000" as UUID,
      };
      const world2: World = {
        id: uuidv4() as UUID,
        agentId: testAgentId,
        name: "World 1",
        messageServerId: "f1111111-1111-4111-8111-111111111111" as UUID,
      };
      await adapter.createWorld(world1);
      await adapter.createWorld(world2);
      const worlds = await adapter.getAllWorlds();
      expect(worlds.length).toBe(2);
    });

    it("should return an empty array if no worlds exist", async () => {
      const worlds = await adapter.getAllWorlds();
      expect(worlds).toEqual([]);
    });
  });
});
