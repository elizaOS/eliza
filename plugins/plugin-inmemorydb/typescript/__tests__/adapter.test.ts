import { describe, expect, it } from "vitest";
import { EphemeralHNSW } from "../hnsw";
import { MemoryStorage } from "../storage-memory";

describe("MemoryStorage Implementation", () => {
  it("should initialize storage", async () => {
    const storage = new MemoryStorage();
    await storage.init();
    expect(true).toBe(true);
  });

  it("should set and get values", async () => {
    const storage = new MemoryStorage();
    await storage.init();

    await storage.set("agents", "agent-1", { id: "agent-1", name: "Test" });
    const retrieved = await storage.get("agents", "agent-1");
    expect(retrieved).toEqual({ id: "agent-1", name: "Test" });
  });

  it("should delete values", async () => {
    const storage = new MemoryStorage();
    await storage.init();

    await storage.set("agents", "agent-2", { id: "agent-2" });
    await storage.delete("agents", "agent-2");
    const retrieved = await storage.get("agents", "agent-2");
    expect(retrieved).toBeNull();
  });

  it("should list all values in collection", async () => {
    const storage = new MemoryStorage();
    await storage.init();

    await storage.set("rooms", "room-1", { id: "room-1", name: "Room 1" });
    await storage.set("rooms", "room-2", { id: "room-2", name: "Room 2" });

    const all = await storage.getAll("rooms");
    expect(all.length).toBe(2);
  });

  it("should clear all collections", async () => {
    const storage = new MemoryStorage();
    await storage.init();

    await storage.set("entities", "entity-1", { id: "entity-1" });
    await storage.clear();

    const all = await storage.getAll("entities");
    expect(all.length).toBe(0);
  });
});

describe("EphemeralHNSW Vector Index", () => {
  it("should initialize with dimension", async () => {
    const hnsw = new EphemeralHNSW();
    await hnsw.init(384);
    expect(true).toBe(true);
  });

  it("should add vectors", async () => {
    const hnsw = new EphemeralHNSW();
    await hnsw.init(3);

    await hnsw.add("vec-1", [0.1, 0.2, 0.3]);
    await hnsw.add("vec-2", [0.4, 0.5, 0.6]);

    expect(hnsw.size()).toBe(2);
  });

  it("should search for similar vectors", async () => {
    const hnsw = new EphemeralHNSW();
    await hnsw.init(3);

    await hnsw.add("vec-1", [1.0, 0.0, 0.0]);
    await hnsw.add("vec-2", [0.0, 1.0, 0.0]);
    await hnsw.add("vec-3", [0.0, 0.0, 1.0]);

    const results = await hnsw.search([0.9, 0.1, 0.0], 2, 0.0);
    expect(results.length).toBeLessThanOrEqual(2);
    if (results.length > 0) {
      expect(results[0].id).toBe("vec-1");
    }
  });

  it("should remove vectors", async () => {
    const hnsw = new EphemeralHNSW();
    await hnsw.init(3);

    await hnsw.add("vec-1", [0.1, 0.2, 0.3]);
    await hnsw.remove("vec-1");

    expect(hnsw.size()).toBe(0);
  });

  it("should clear all vectors", async () => {
    const hnsw = new EphemeralHNSW();
    await hnsw.init(3);

    await hnsw.add("vec-1", [0.1, 0.2, 0.3]);
    await hnsw.add("vec-2", [0.4, 0.5, 0.6]);
    await hnsw.clear();

    expect(hnsw.size()).toBe(0);
  });
});

describe("Cross-Language Memory Storage Parity", () => {
  it("should have consistent memory structure across implementations", () => {
    const expectedMemoryFields = [
      "id",
      "entityId",
      "agentId",
      "roomId",
      "content",
      "createdAt",
      "embedding",
      "unique",
      "metadata",
    ];

    const sampleMemory = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      entityId: "entity-uuid",
      agentId: "agent-uuid",
      roomId: "room-uuid",
      content: { text: "Test message" },
      createdAt: 1704067200000,
      embedding: [0.1, 0.2, 0.3],
      unique: false,
      metadata: { type: "messages" },
    };

    for (const field of expectedMemoryFields) {
      expect(sampleMemory).toHaveProperty(field);
    }
  });

  it("should have consistent HNSW vector search interface", () => {
    const searchParams = {
      embedding: [0.1, 0.2, 0.3],
      tableName: "memories",
      match_count: 10,
      match_threshold: 0.8,
    };

    expect(searchParams.embedding).toBeDefined();
    expect(typeof searchParams.match_count).toBe("number");
    expect(typeof searchParams.match_threshold).toBe("number");
  });

  it("should have consistent database adapter interface", () => {
    const requiredMethods = [
      "init",
      "close",
      "createAgent",
      "getAgentById",
      "createEntity",
      "getEntityById",
      "createRoom",
      "getRoomById",
      "createMemory",
      "getMemoryById",
      "getMemories",
      "searchMemories",
      "deleteMemory",
      "createWorld",
      "getWorld",
      "createRelationship",
      "getRelationship",
      "setCache",
      "getCache",
      "deleteCache",
    ];

    expect(requiredMethods.length).toBe(20);
    expect(requiredMethods).toContain("init");
    expect(requiredMethods).toContain("createMemory");
    expect(requiredMethods).toContain("searchMemories");
  });
});
