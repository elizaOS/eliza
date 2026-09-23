/**
 * Exercises access-context scope, world, and authorized-room enforcement
 * against the real ephemeral adapter, including pagination and vector ranking.
 */
import { randomUUID } from "node:crypto";
import type { AccessContext, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

describe("access-context memory enforcement", () => {
  const agentId = randomUUID() as UUID;
  const requester = randomUUID() as UUID;
  const stranger = randomUUID() as UUID;
  const allowedRoom = randomUUID() as UUID;
  const otherRoom = randomUUID() as UUID;
  const otherWorldRoom = randomUUID() as UUID;
  const allowedWorld = randomUUID() as UUID;
  const otherWorld = randomUUID() as UUID;

  let adapter: InMemoryDatabaseAdapter;

  const vector = (first: number, second: number): number[] => [
    first,
    second,
    ...Array.from({ length: 382 }, () => 0),
  ];

  const context: AccessContext = {
    requesterEntityId: requester,
    worldId: allowedWorld,
    authorizedRoomIds: [allowedRoom],
    role: "USER",
    isOwner: false,
  };

  beforeEach(async () => {
    const storage = new MemoryStorage();
    await storage.init();
    adapter = new InMemoryDatabaseAdapter(storage, agentId);
    await adapter.init();

    const seed: Memory[] = [
      {
        id: randomUUID() as UUID,
        entityId: requester,
        roomId: allowedRoom,
        worldId: allowedWorld,
        createdAt: 100,
        content: { text: "needle allowed global" },
        embedding: vector(0.8, 0.2),
        metadata: { type: "custom", scope: "global" },
      },
      {
        id: randomUUID() as UUID,
        entityId: requester,
        roomId: allowedRoom,
        worldId: allowedWorld,
        createdAt: 200,
        content: { text: "needle allowed private" },
        embedding: vector(0.9, 0.1),
        metadata: { type: "custom", scope: "private" },
      },
      {
        id: randomUUID() as UUID,
        entityId: stranger,
        roomId: allowedRoom,
        worldId: allowedWorld,
        createdAt: 500,
        content: { text: "needle denied private" },
        embedding: vector(1, 0),
        metadata: { type: "custom", scope: "private" },
      },
      {
        id: randomUUID() as UUID,
        entityId: requester,
        roomId: otherRoom,
        worldId: allowedWorld,
        createdAt: 400,
        content: { text: "needle denied room" },
        embedding: vector(1, 0),
        metadata: { type: "custom", scope: "global" },
      },
      {
        id: randomUUID() as UUID,
        entityId: requester,
        roomId: otherWorldRoom,
        worldId: otherWorld,
        createdAt: 300,
        content: { text: "needle denied world" },
        embedding: vector(1, 0),
        metadata: { type: "custom", scope: "global" },
      },
    ];
    await adapter.createMemories(seed.map((memory) => ({ memory, tableName: "messages" })));
  });

  it("intersects scope, world, and authorized rooms before list pagination", async () => {
    const result = await adapter.getMemories({
      tableName: "messages",
      accessContext: context,
      limit: 1,
    });

    expect(result.map((memory) => memory.content.text)).toEqual(["needle allowed private"]);
  });

  it("does not trust caller-supplied room ids as authorization", async () => {
    const result = await adapter.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds: [allowedRoom, otherRoom, otherWorldRoom],
      accessContext: context,
    });

    expect(result.map((memory) => memory.content.text)).toEqual([
      "needle allowed private",
      "needle allowed global",
    ]);
  });

  it("filters before full-text ranking and pagination", async () => {
    const result = await adapter.searchMessages({
      tableName: "messages",
      roomIds: [allowedRoom, otherRoom, otherWorldRoom],
      query: "needle",
      accessContext: context,
      limit: 1,
    });

    expect(result[0]?.memory.content.text).toMatch(/^needle allowed /);
  });

  it("finds the top authorized vector when closer unauthorized rows exist", async () => {
    const result = await adapter.searchMemories({
      tableName: "messages",
      embedding: vector(1, 0),
      match_threshold: 0,
      accessContext: context,
      limit: 1,
    });

    expect(result.map((memory) => memory.content.text)).toEqual(["needle allowed private"]);
  });

  it("treats an explicit empty room authorization as deny-all", async () => {
    const result = await adapter.getMemories({
      tableName: "messages",
      accessContext: { ...context, authorizedRoomIds: [] },
    });

    expect(result).toEqual([]);
  });
});
