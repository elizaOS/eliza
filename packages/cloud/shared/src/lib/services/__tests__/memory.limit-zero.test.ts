/**
 * Exercises all three MemoryService retrieval branches against real PGlite
 * tables while replacing only the runtime and cache collaborators. The suite
 * proves zero, omitted, and positive limits reach the production query paths.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const USER_A_ID = "10000000-0000-4000-8000-000000000002";
const USER_B_ID = "10000000-0000-4000-8000-000000000003";
const AGENT_ID = "10000000-0000-4000-8000-000000000004" as UUID;
const ROOM_A_ID = "10000000-0000-4000-8000-000000000005";
const ROOM_B_ID = "10000000-0000-4000-8000-000000000006";

type SearchMemoriesInput = Parameters<AgentRuntime["searchMemories"]>[0];
const searchCalls: SearchMemoriesInput[] = [];

const runtime = {
  agentId: AGENT_ID,
  searchMemories: async (input: SearchMemoriesInput): Promise<Memory[]> => {
    searchCalls.push(input);
    return [];
  },
};

mock.module("../../eliza/runtime-factory", () => ({
  runtimeFactory: { createRuntimeForUser: async () => runtime },
}));
mock.module("../../eliza/user-context", () => ({
  userContextService: { createSystemContext: () => ({}) },
}));
mock.module("../../cache/memory-cache", () => ({
  memoryCache: {
    getSearchResults: async () => null,
    cacheSearchResults: async () => undefined,
  },
}));

let closeDatabase: () => Promise<void>;

beforeAll(async () => {
  const { closeDatabaseConnectionsForTests, dbWrite } = await import("../../../db/client");
  const { pushSchemaToTestDb } = await import("../../../db/push-schema-for-tests");
  const { organizations } = await import("../../../db/schemas/organizations");
  const { users } = await import("../../../db/schemas/users");
  const { agentTable, entityTable, memoryTable, participantTable, roomTable } = await import(
    "../../../db/schemas/eliza"
  );

  closeDatabase = closeDatabaseConnectionsForTests;
  await pushSchemaToTestDb({
    agentTable,
    entityTable,
    memoryTable,
    organizations,
    participantTable,
    roomTable,
    users,
  });

  await dbWrite.insert(organizations).values({
    id: ORGANIZATION_ID,
    name: "Memory pagination org",
    slug: "memory-pagination-org",
  });
  await dbWrite.insert(users).values([
    {
      id: USER_A_ID,
      organization_id: ORGANIZATION_ID,
      steward_user_id: "memory-limit-user-a",
    },
    {
      id: USER_B_ID,
      organization_id: ORGANIZATION_ID,
      steward_user_id: "memory-limit-user-b",
    },
  ]);
  await dbWrite.insert(agentTable).values({ id: AGENT_ID, name: "Memory pagination agent" });
  await dbWrite.insert(entityTable).values([
    { id: USER_A_ID, agentId: AGENT_ID },
    { id: USER_B_ID, agentId: AGENT_ID },
  ]);
  await dbWrite.insert(roomTable).values([
    { id: ROOM_A_ID, agentId: AGENT_ID, source: "test", type: "DM" },
    { id: ROOM_B_ID, agentId: AGENT_ID, source: "test", type: "DM" },
  ]);
  await dbWrite.insert(participantTable).values([
    { entityId: USER_A_ID, roomId: ROOM_A_ID, agentId: AGENT_ID },
    { entityId: USER_B_ID, roomId: ROOM_B_ID, agentId: AGENT_ID },
  ]);

  const memoryRows = [
    ...Array.from({ length: 12 }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index + 11).padStart(12, "0")}`,
      roomId: ROOM_A_ID,
      entityId: USER_A_ID,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      roomId: ROOM_B_ID,
      entityId: USER_B_ID,
    })),
  ];
  await dbWrite.insert(memoryTable).values(
    memoryRows.map((row, index) => ({
      ...row,
      agentId: AGENT_ID,
      type: "messages",
      content: { text: `memory-${index}` },
    })),
  );
}, 60_000);

beforeEach(() => {
  searchCalls.length = 0;
});

afterAll(async () => {
  await closeDatabase();
  mock.restore();
});

describe("MemoryService.retrieveMemories pagination", () => {
  test("query retrieval passes zero, default, and positive limits to runtime search", async () => {
    const { memoryService } = await import("../memory");

    await memoryService.retrieveMemories({
      organizationId: ORGANIZATION_ID,
      roomId: ROOM_A_ID,
      query: "needle-zero",
      limit: 0,
    });
    await memoryService.retrieveMemories({
      organizationId: ORGANIZATION_ID,
      roomId: ROOM_A_ID,
      query: "needle-default",
    });
    await memoryService.retrieveMemories({
      organizationId: ORGANIZATION_ID,
      roomId: ROOM_A_ID,
      query: "needle-positive",
      limit: 2,
    });

    expect(searchCalls.map((call) => call.limit)).toEqual([0, undefined, 2]);
  });

  test("single-room SQL retrieval honors zero, default, and positive limits", async () => {
    const { memoryService } = await import("../memory");

    const zero = await memoryService.retrieveMemories({
      organizationId: ORGANIZATION_ID,
      roomId: ROOM_A_ID,
      limit: 0,
    });
    const omitted = await memoryService.retrieveMemories({
      organizationId: ORGANIZATION_ID,
      roomId: ROOM_A_ID,
    });
    const positive = await memoryService.retrieveMemories({
      organizationId: ORGANIZATION_ID,
      roomId: ROOM_A_ID,
      limit: 2,
    });

    expect(zero).toHaveLength(0);
    expect(omitted).toHaveLength(12);
    expect(positive).toHaveLength(2);
  });

  test("all-room SQL retrieval honors zero, default, and positive limits", async () => {
    const { memoryService } = await import("../memory");

    const zero = await memoryService.retrieveMemories({
      organizationId: ORGANIZATION_ID,
      limit: 0,
    });
    const omitted = await memoryService.retrieveMemories({ organizationId: ORGANIZATION_ID });
    const positive = await memoryService.retrieveMemories({
      organizationId: ORGANIZATION_ID,
      limit: 2,
    });

    expect(zero).toHaveLength(0);
    expect(omitted).toHaveLength(14);
    expect(positive).toHaveLength(2);
  });
});
