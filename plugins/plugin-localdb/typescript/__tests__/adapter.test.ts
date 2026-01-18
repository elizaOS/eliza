import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDatabaseAdapter } from "../adapter";
import { NodeStorage } from "../storage-node";

const TEST_DATA_DIR = join(process.cwd(), ".test-data");
const TEST_AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;

describe("LocalDatabaseAdapter", () => {
  let storage: NodeStorage;
  let adapter: LocalDatabaseAdapter;

  beforeEach(async () => {
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }

    storage = new NodeStorage(TEST_DATA_DIR);
    adapter = new LocalDatabaseAdapter(storage, TEST_AGENT_ID);
    await adapter.init();
  });

  afterEach(async () => {
    await adapter.close();
    if (existsSync(TEST_DATA_DIR)) {
      rmSync(TEST_DATA_DIR, { recursive: true });
    }
  });

  describe("initialization", () => {
    it("should initialize successfully", async () => {
      expect(await adapter.isReady()).toBe(true);
    });

    it("should close successfully", async () => {
      await adapter.close();
      expect(await adapter.isReady()).toBe(false);
    });
  });

  describe("agent operations", () => {
    const testAgent = {
      id: "00000000-0000-0000-0000-000000000002" as UUID,
      name: "Test Agent",
    };

    it("should create an agent", async () => {
      const result = await adapter.createAgent(testAgent);
      expect(result).toBe(true);
    });

    it("should get an agent by ID", async () => {
      await adapter.createAgent(testAgent);
      const agent = await adapter.getAgent(testAgent.id);
      expect(agent).not.toBeNull();
      expect(agent?.name).toBe("Test Agent");
    });

    it("should get all agents", async () => {
      await adapter.createAgent(testAgent);
      await adapter.createAgent({
        id: "00000000-0000-0000-0000-000000000003" as UUID,
        name: "Test Agent 2",
      });
      const agents = await adapter.getAgents();
      expect(agents.length).toBe(2);
    });

    it("should update an agent", async () => {
      await adapter.createAgent(testAgent);
      await adapter.updateAgent(testAgent.id, { name: "Updated Agent" });
      const agent = await adapter.getAgent(testAgent.id);
      expect(agent?.name).toBe("Updated Agent");
    });

    it("should delete an agent", async () => {
      await adapter.createAgent(testAgent);
      const result = await adapter.deleteAgent(testAgent.id);
      expect(result).toBe(true);
      const agent = await adapter.getAgent(testAgent.id);
      expect(agent).toBeNull();
    });
  });

  describe("memory operations", () => {
    const roomId = "00000000-0000-0000-0000-000000000010" as UUID;

    it("should create a memory", async () => {
      const memory = {
        content: { text: "Hello, world!" },
        roomId,
        entityId: TEST_AGENT_ID,
      };

      const id = await adapter.createMemory(memory, "messages");
      expect(id).toBeDefined();
    });

    it("should get a memory by ID", async () => {
      const memory = {
        content: { text: "Hello, world!" },
        roomId,
        entityId: TEST_AGENT_ID,
      };

      const id = await adapter.createMemory(memory, "messages");
      const retrieved = await adapter.getMemoryById(id);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.content.text).toBe("Hello, world!");
    });

    it("should get memories by room ID", async () => {
      await adapter.createMemory(
        { content: { text: "Message 1" }, roomId, entityId: TEST_AGENT_ID },
        "messages"
      );
      await adapter.createMemory(
        { content: { text: "Message 2" }, roomId, entityId: TEST_AGENT_ID },
        "messages"
      );

      const memories = await adapter.getMemories({
        roomId,
        tableName: "messages",
      });
      expect(memories.length).toBe(2);
    });

    it("should update a memory", async () => {
      const id = await adapter.createMemory(
        { content: { text: "Original" }, roomId, entityId: TEST_AGENT_ID },
        "messages"
      );

      await adapter.updateMemory({ id, content: { text: "Updated" } });
      const memory = await adapter.getMemoryById(id);
      expect(memory?.content.text).toBe("Updated");
    });

    it("should delete a memory", async () => {
      const id = await adapter.createMemory(
        { content: { text: "To delete" }, roomId, entityId: TEST_AGENT_ID },
        "messages"
      );

      await adapter.deleteMemory(id);
      const memory = await adapter.getMemoryById(id);
      expect(memory).toBeNull();
    });

    it("should count memories", async () => {
      await adapter.createMemory(
        { content: { text: "1" }, roomId, entityId: TEST_AGENT_ID },
        "messages"
      );
      await adapter.createMemory(
        { content: { text: "2" }, roomId, entityId: TEST_AGENT_ID },
        "messages"
      );

      const count = await adapter.countMemories(roomId, false, "messages");
      expect(count).toBe(2);
    });
  });

  describe("vector search", () => {
    const roomId = "00000000-0000-0000-0000-000000000020" as UUID;

    it("should store and search embeddings", async () => {
      // Ensure dimension is set
      await adapter.ensureEmbeddingDimension(3);

      // Create memories with embeddings
      await adapter.createMemory(
        {
          content: { text: "Hello world" },
          roomId,
          entityId: TEST_AGENT_ID,
          embedding: [1.0, 0.0, 0.0],
        },
        "documents"
      );

      await adapter.createMemory(
        {
          content: { text: "Goodbye world" },
          roomId,
          entityId: TEST_AGENT_ID,
          embedding: [0.0, 1.0, 0.0],
        },
        "documents"
      );

      await adapter.createMemory(
        {
          content: { text: "Similar to hello" },
          roomId,
          entityId: TEST_AGENT_ID,
          embedding: [0.9, 0.1, 0.0],
        },
        "documents"
      );

      // Search for similar vectors
      const results = await adapter.searchMemories({
        tableName: "documents",
        embedding: [1.0, 0.0, 0.0],
        match_threshold: 0.5,
        count: 2,
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content.text).toBe("Hello world");
    });
  });

  describe("room operations", () => {
    it("should create rooms", async () => {
      const rooms = [
        { name: "Room 1", worldId: "world1" as UUID },
        { name: "Room 2", worldId: "world1" as UUID },
      ];

      const ids = await adapter.createRooms(rooms);
      expect(ids.length).toBe(2);
    });

    it("should get rooms by IDs", async () => {
      const ids = await adapter.createRooms([{ name: "Room 1", worldId: "world1" as UUID }]);

      const rooms = await adapter.getRoomsByIds(ids);
      expect(rooms).not.toBeNull();
      expect(rooms?.length).toBe(1);
      expect(rooms?.[0].name).toBe("Room 1");
    });

    it("should delete a room", async () => {
      const ids = await adapter.createRooms([{ name: "To delete", worldId: "world1" as UUID }]);

      await adapter.deleteRoom(ids[0]);
      const rooms = await adapter.getRoomsByIds(ids);
      expect(rooms).toBeNull();
    });
  });

  describe("participant operations", () => {
    const roomId = "00000000-0000-0000-0000-000000000030" as UUID;
    const entityId = "00000000-0000-0000-0000-000000000031" as UUID;

    it("should add participants to room", async () => {
      await adapter.createRooms([{ id: roomId, name: "Test Room" }]);
      const result = await adapter.addParticipantsRoom([entityId], roomId);
      expect(result).toBe(true);
    });

    it("should check if entity is room participant", async () => {
      await adapter.createRooms([{ id: roomId, name: "Test Room" }]);
      await adapter.addParticipantsRoom([entityId], roomId);

      const isParticipant = await adapter.isRoomParticipant(roomId, entityId);
      expect(isParticipant).toBe(true);
    });

    it("should get participants for room", async () => {
      await adapter.createRooms([{ id: roomId, name: "Test Room" }]);
      await adapter.addParticipantsRoom([entityId], roomId);

      const participants = await adapter.getParticipantsForRoom(roomId);
      expect(participants).toContain(entityId);
    });

    it("should remove participant from room", async () => {
      await adapter.createRooms([{ id: roomId, name: "Test Room" }]);
      await adapter.addParticipantsRoom([entityId], roomId);
      await adapter.removeParticipant(entityId, roomId);

      const isParticipant = await adapter.isRoomParticipant(roomId, entityId);
      expect(isParticipant).toBe(false);
    });
  });

  describe("cache operations", () => {
    it("should set and get cache", async () => {
      await adapter.setCache("test-key", { value: "test-value" });
      const cached = await adapter.getCache("test-key");
      expect(cached).toEqual({ value: "test-value" });
    });

    it("should delete cache", async () => {
      await adapter.setCache("test-key", "value");
      await adapter.deleteCache("test-key");
      const cached = await adapter.getCache("test-key");
      expect(cached).toBeUndefined();
    });
  });

  describe("task operations", () => {
    const roomId = "00000000-0000-0000-0000-000000000040" as UUID;

    it("should create a task", async () => {
      const id = await adapter.createTask({
        name: "Test Task",
        roomId,
        tags: ["test"],
      });
      expect(id).toBeDefined();
    });

    it("should get task by ID", async () => {
      const id = await adapter.createTask({
        name: "Test Task",
        roomId,
        tags: ["test"],
      });

      const task = await adapter.getTask(id);
      expect(task).not.toBeNull();
      expect(task?.name).toBe("Test Task");
    });

    it("should get tasks by name", async () => {
      await adapter.createTask({ name: "Named Task", roomId, tags: [] });

      const tasks = await adapter.getTasksByName("Named Task");
      expect(tasks.length).toBe(1);
    });

    it("should update task", async () => {
      const id = await adapter.createTask({
        name: "Original",
        roomId,
        tags: [],
      });

      await adapter.updateTask(id, { name: "Updated" });
      const task = await adapter.getTask(id);
      expect(task?.name).toBe("Updated");
    });

    it("should delete task", async () => {
      const id = await adapter.createTask({
        name: "To delete",
        roomId,
        tags: [],
      });

      await adapter.deleteTask(id);
      const task = await adapter.getTask(id);
      expect(task).toBeNull();
    });
  });

  describe("world operations", () => {
    it("should create a world", async () => {
      const id = await adapter.createWorld({ name: "Test World" });
      expect(id).toBeDefined();
    });

    it("should get world by ID", async () => {
      const id = await adapter.createWorld({ name: "Test World" });
      const world = await adapter.getWorld(id);
      expect(world).not.toBeNull();
      expect(world?.name).toBe("Test World");
    });

    it("should get all worlds", async () => {
      await adapter.createWorld({ name: "World 1" });
      await adapter.createWorld({ name: "World 2" });

      const worlds = await adapter.getAllWorlds();
      expect(worlds.length).toBe(2);
    });

    it("should remove world", async () => {
      const id = await adapter.createWorld({ name: "To delete" });
      await adapter.removeWorld(id);
      const world = await adapter.getWorld(id);
      expect(world).toBeNull();
    });
  });

  describe("relationship operations", () => {
    const sourceId = "00000000-0000-0000-0000-000000000050" as UUID;
    const target = "00000000-0000-0000-0000-000000000051" as UUID;

    it("should create a relationship", async () => {
      const result = await adapter.createRelationship({
        sourceEntityId: sourceId,
        targetEntityId: target,
        tags: ["friend"],
      });
      expect(result).toBe(true);
    });

    it("should get relationship", async () => {
      await adapter.createRelationship({
        sourceEntityId: sourceId,
        targetEntityId: target,
        tags: ["friend"],
      });

      const relationship = await adapter.getRelationship({
        sourceEntityId: sourceId,
        targetEntityId: target,
      });
      expect(relationship).not.toBeNull();
      expect(relationship?.tags).toContain("friend");
    });

    it("should get relationships for entity", async () => {
      await adapter.createRelationship({
        sourceEntityId: sourceId,
        targetEntityId: target,
        tags: ["friend"],
      });

      const relationships = await adapter.getRelationships({
        entityId: sourceId,
      });
      expect(relationships.length).toBe(1);
    });
  });
});
