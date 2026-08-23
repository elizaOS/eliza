/**
 * Verifies scope, world, and authorized-room memory enforcement inside real
 * PGlite/Postgres queries before list pagination, text ranking, and vector top-k.
 */
import {
  type AccessContext,
  ChannelType,
  type Entity,
  type Memory,
  type Room,
  type UUID,
  type World,
} from "@elizaos/core";
import { v4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("memory access-context enforcement", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let cleanup: () => Promise<void>;
  let agentId: UUID;

  const requester = v4() as UUID;
  const stranger = v4() as UUID;
  const allowedWorld = v4() as UUID;
  const otherWorld = v4() as UUID;
  const allowedRoom = v4() as UUID;
  const otherRoom = v4() as UUID;
  const otherWorldRoom = v4() as UUID;

  const vector = (first: number, second: number): number[] => [
    first,
    second,
    ...Array.from({ length: 382 }, () => 0),
  ];

  const context = (): AccessContext => ({
    requesterEntityId: requester,
    worldId: allowedWorld,
    authorizedRoomIds: [allowedRoom],
    role: "USER",
  });

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("memory_access_context");
    adapter = setup.adapter;
    cleanup = setup.cleanup;
    agentId = setup.testAgentId;

    await adapter.createWorld({
      id: allowedWorld,
      agentId,
      name: "Allowed world",
      serverId: "access-context-allowed",
    } as World);
    await adapter.createWorld({
      id: otherWorld,
      agentId,
      name: "Other world",
      serverId: "access-context-other",
    } as World);
    await adapter.createRooms([
      {
        id: allowedRoom,
        agentId,
        worldId: allowedWorld,
        name: "Allowed room",
        source: "test",
        type: ChannelType.GROUP,
      },
      {
        id: otherRoom,
        agentId,
        worldId: allowedWorld,
        name: "Unauthorized room",
        source: "test",
        type: ChannelType.GROUP,
      },
      {
        id: otherWorldRoom,
        agentId,
        worldId: otherWorld,
        name: "Other-world room",
        source: "test",
        type: ChannelType.GROUP,
      },
    ] as Room[]);
    await adapter.createEntities([
      { id: requester, agentId, names: ["Requester"] },
      { id: stranger, agentId, names: ["Stranger"] },
    ] as Entity[]);

    const create = async (
      text: string,
      createdAt: number,
      overrides: Partial<Memory>
    ): Promise<void> => {
      await adapter.createMemory(
        {
          id: v4() as UUID,
          agentId,
          entityId: requester,
          roomId: allowedRoom,
          worldId: allowedWorld,
          createdAt,
          content: { text },
          embedding: vector(0.8, 0.2),
          metadata: { type: "custom", scope: "global" },
          ...overrides,
        } as Memory,
        "messages"
      );
    };

    await create("needle allowed global", 100, {});
    await create("needle allowed legacy private", 150, {
      embedding: vector(0.7, 0.3),
      metadata: { type: "custom" },
    });
    await create("needle allowed private", 200, {
      embedding: vector(0.9, 0.1),
      metadata: { type: "custom", scope: "private" },
    });
    await create("needle denied private", 500, {
      entityId: stranger,
      embedding: vector(1, 0),
      metadata: { type: "custom", scope: "private" },
    });
    await create("needle denied legacy private", 600, {
      entityId: stranger,
      embedding: vector(1, 0),
      metadata: { type: "custom" },
    });
    await create("needle denied room", 400, {
      roomId: otherRoom,
      embedding: vector(1, 0),
    });
    await create("needle denied world", 300, {
      roomId: otherWorldRoom,
      worldId: otherWorld,
      embedding: vector(1, 0),
    });
  });

  afterAll(async () => {
    await cleanup?.();
  });

  it("filters scope, world, and room before list pagination", async () => {
    const rows = await adapter.getMemories({
      tableName: "messages",
      accessContext: context(),
      includeEmbedding: false,
      limit: 1,
    });

    expect(rows.map((row) => row.content.text)).toEqual(["needle allowed private"]);
  });

  it("intersects requested rooms with the authorized-room set", async () => {
    const rows = await adapter.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds: [allowedRoom, otherRoom, otherWorldRoom],
      accessContext: context(),
    });

    expect(rows.map((row) => row.content.text)).toEqual([
      "needle allowed private",
      "needle allowed legacy private",
      "needle allowed global",
    ]);
  });

  it("filters before text ranking and pagination", async () => {
    const rows = await adapter.searchMessages({
      tableName: "messages",
      roomIds: [allowedRoom, otherRoom, otherWorldRoom],
      query: "needle",
      accessContext: context(),
      limit: 1,
    });

    expect(rows[0]?.memory.content.text).toMatch(/^needle allowed /);
  });

  it("returns the top authorized vector despite closer unauthorized rows", async () => {
    const rows = await adapter.searchMemories({
      tableName: "messages",
      embedding: vector(1, 0),
      match_threshold: 0,
      accessContext: context(),
      limit: 1,
    });

    expect(rows.map((row) => row.content.text)).toEqual(["needle allowed private"]);
  });

  it("treats an explicit empty authorized-room set as deny-all", async () => {
    const rows = await adapter.getMemories({
      tableName: "messages",
      accessContext: { ...context(), authorizedRoomIds: [] },
    });

    expect(rows).toEqual([]);
  });
});
