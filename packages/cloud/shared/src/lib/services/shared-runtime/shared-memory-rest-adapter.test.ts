/** Product DTO and query-contract tests for the Shared Memories REST adapter. */

import { describe, expect, test } from "bun:test";
import type {
  CountSharedAgentMemoriesInput,
  ListSharedAgentMemoriesInput,
  SharedAgentMemoriesReader,
  SharedAgentMemoryScope,
} from "../../../db/repositories/shared-agent-memories";
import type { SharedAgentMemoryRow } from "../../../db/schemas/shared-agent-memories";
import { isSharedMemoryRestPath, sharedMemoryRestRequest } from "./shared-memory-rest-adapter";
import { sharedTodoStorageScope } from "./shared-runtime-storage-identity";

const IDENTITY = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  sourceAgentId: "33333333-3333-4333-8333-333333333333",
};

const MEMORY_ID = "44444444-4444-4444-8444-444444444444";
const ENTITY_ID = "55555555-5555-4555-8555-555555555555";
const ROOM_ID = "66666666-6666-4666-8666-666666666666";

function memoryRow(): SharedAgentMemoryRow {
  const agentId = sharedTodoStorageScope({
    sourceAgentId: IDENTITY.sourceAgentId,
    ownerId: IDENTITY.userId,
  }).agentId;
  return {
    id: MEMORY_ID,
    organization_id: IDENTITY.organizationId,
    user_id: IDENTITY.userId,
    agent_id: agentId,
    entity_id: ENTITY_ID,
    room_id: ROOM_ID,
    world_id: null,
    type: "messages",
    content: {
      text: "Remember the orange clouds",
      source: "shared-runtime",
      metadata: { role: "user" },
    },
    embedding: null,
    embedding_model: null,
    created_at: new Date("2026-08-25T12:00:00.000Z"),
  };
}

function dependencies(options?: {
  hasMore?: boolean;
  rows?: SharedAgentMemoryRow[];
  total?: number;
}) {
  const calls: Array<{
    scope: SharedAgentMemoryScope;
    input: ListSharedAgentMemoriesInput;
  }> = [];
  const countCalls: Array<{
    scope: SharedAgentMemoryScope;
    input: CountSharedAgentMemoriesInput;
  }> = [];
  const reader: Pick<SharedAgentMemoriesReader, "listPage" | "countMatching" | "countByType"> = {
    listPage: async (scope, input) => {
      calls.push({ scope, input });
      return {
        rows: options?.rows ?? [memoryRow()],
        hasMore: options?.hasMore ?? false,
      };
    },
    countMatching: async (scope, input) => {
      countCalls.push({ scope, input });
      return options?.total ?? 1;
    },
    countByType: async () => [
      { type: "facts", count: 2 },
      { type: "messages", count: 3 },
    ],
  };
  return { calls, countCalls, value: { enabled: true, reader } };
}

describe("Shared Memories REST adapter", () => {
  test("recognizes only the Memories-view endpoint families", () => {
    expect(isSharedMemoryRestPath("memories/feed")).toBe(true);
    expect(isSharedMemoryRestPath("memories/browse")).toBe(true);
    expect(isSharedMemoryRestPath("memories/stats")).toBe(true);
    expect(isSharedMemoryRestPath(`memories/by-entity/${ENTITY_ID}`)).toBe(true);
    expect(isSharedMemoryRestPath("memory/remember")).toBe(false);
  });

  test("projects a stable feed DTO from the tenant-pinned durable store", async () => {
    const fake = dependencies({ hasMore: true });
    const result = await sharedMemoryRestRequest(
      {
        path: "memories/feed",
        searchParams: new URLSearchParams({ type: "messages", limit: "20" }),
        identity: IDENTITY,
      },
      fake.value,
    );

    expect(result.status).toBe(200);
    expect(result.data).toEqual({
      memories: [
        {
          id: MEMORY_ID,
          type: "messages",
          text: "Remember the orange clouds",
          entityId: ENTITY_ID,
          roomId: ROOM_ID,
          agentId: expect.any(String),
          createdAt: Date.parse("2026-08-25T12:00:00.000Z"),
          metadata: { role: "user" },
          source: "shared-runtime",
        },
      ],
      count: 1,
      limit: 20,
      hasMore: true,
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.scope).toEqual({
      organizationId: IDENTITY.organizationId,
      userId: IDENTITY.userId,
      agentId: sharedTodoStorageScope({
        sourceAgentId: IDENTITY.sourceAgentId,
        ownerId: IDENTITY.userId,
      }).agentId,
    });
    expect(fake.calls[0]?.input).toEqual({ limit: 20, type: "messages" });
  });

  test("validates person-scoped browsing and reports an exact filtered total", async () => {
    const fake = dependencies({ hasMore: true, total: 137 });
    const result = await sharedMemoryRestRequest(
      {
        path: `memories/by-entity/${ENTITY_ID}`,
        searchParams: new URLSearchParams({
          entityIds: ENTITY_ID,
          q: "orange",
          offset: "50",
          limit: "50",
        }),
        identity: IDENTITY,
      },
      fake.value,
    );

    expect(result.status).toBe(200);
    expect(result.data.entityId).toBe(ENTITY_ID);
    expect(result.data.total).toBe(137);
    expect(result.data.totalIsExact).toBe(true);
    expect(result.data.hasMore).toBe(true);
    expect(fake.calls[0]?.input).toEqual({
      limit: 50,
      offset: 50,
      entityIds: [ENTITY_ID],
      textQuery: "orange",
    });
    expect(fake.countCalls).toEqual([
      {
        scope: fake.calls[0]?.scope,
        input: {
          entityIds: [ENTITY_ID],
          textQuery: "orange",
        },
      },
    ]);
  });

  test("does not invent an exact total from an empty page beyond the end", async () => {
    const fake = dependencies({ rows: [], total: 3 });
    const result = await sharedMemoryRestRequest(
      {
        path: "memories/browse",
        searchParams: new URLSearchParams({ offset: "50", limit: "50" }),
        identity: IDENTITY,
      },
      fake.value,
    );

    expect(result.data).toEqual({
      memories: [],
      total: 3,
      totalIsExact: true,
      hasMore: false,
      limit: 50,
      offset: 50,
    });
  });

  test("returns exact type stats", async () => {
    const fake = dependencies();
    const result = await sharedMemoryRestRequest(
      {
        path: "memories/stats",
        searchParams: new URLSearchParams(),
        identity: IDENTITY,
      },
      fake.value,
    );
    expect(result).toEqual({
      status: 200,
      data: { total: 5, byType: { facts: 2, messages: 3 } },
    });
  });

  test("rejects malformed cursors before touching storage", async () => {
    const fake = dependencies();
    const result = await sharedMemoryRestRequest(
      {
        path: "memories/feed",
        searchParams: new URLSearchParams({ beforeId: "not-a-uuid" }),
        identity: IDENTITY,
      },
      fake.value,
    );
    expect(result.status).toBe(400);
    expect(result.data.code).toBe("invalid_memory_query");
    expect(fake.calls).toHaveLength(0);
  });

  test("surfaces a typed unavailable state when durable memory is disabled", async () => {
    const fake = dependencies();
    const result = await sharedMemoryRestRequest(
      {
        path: "memories/feed",
        searchParams: new URLSearchParams(),
        identity: IDENTITY,
      },
      { ...fake.value, enabled: false },
    );
    expect(result.status).toBe(503);
    expect(result.data.code).toBe("memory_runtime_unavailable");
    expect(fake.calls).toHaveLength(0);
  });
});
