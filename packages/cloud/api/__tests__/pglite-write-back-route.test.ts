// Exercises cloud API tests pglite write back route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireServiceKey = mock(async () => ({
  organizationId: "service-org",
  userId: "service-user",
}));

const operations: Array<{
  kind: "insert" | "update" | "delete";
  row?: Record<string, unknown>;
  set?: Record<string, unknown>;
}> = [];

let updateReturningRows: unknown[] = [];

const writeTransaction = mock(async (fn: (tx: unknown) => Promise<void>) => {
  const tx = {
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoUpdate: async () => {
          operations.push({ kind: "insert", row });
        },
        onConflictDoNothing: async () => {
          operations.push({ kind: "insert", row });
        },
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            operations.push({ kind: "update", set });
            return updateReturningRows;
          },
        }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: async () => {
          operations.push({ kind: "delete" });
          return [{ id: "deleted" }];
        },
      }),
    }),
  };

  await fn(tx);
});

mock.module("@/lib/auth/service-key-hono-worker", () => ({
  requireServiceKey,
}));

mock.module("@/db/helpers", () => ({
  writeTransaction,
}));

mock.module("@/db/schemas/eliza", () => {
  const column = (name: string) => ({ name });
  return {
    agentTable: { id: column("agents.id") },
    entityTable: {
      id: column("entities.id"),
      agentId: column("entities.agent_id"),
    },
    memoryTable: {
      id: column("memories.id"),
      agentId: column("memories.agent_id"),
    },
    participantTable: {
      id: column("participants.id"),
      entityId: column("participants.entity_id"),
      roomId: column("participants.room_id"),
      agentId: column("participants.agent_id"),
    },
    relationshipTable: {
      id: column("relationships.id"),
      agentId: column("relationships.agent_id"),
    },
    roomTable: { id: column("rooms.id"), agentId: column("rooms.agent_id") },
    taskTable: { id: column("tasks.id"), agentId: column("tasks.agent_id") },
    worldTable: { id: column("worlds.id"), agentId: column("worlds.agent_id") },
  };
});

mock.module("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

const { default: writeBackRoute } = await import(
  "../v1/eliza/agents/[agentId]/write/route"
);

describe("PGlite write-back route", () => {
  const app = new Hono();
  app.route("/api/v1/eliza/agents/:agentId/write", writeBackRoute);

  beforeEach(() => {
    requireServiceKey.mockClear();
    writeTransaction.mockClear();
    operations.length = 0;
    updateReturningRows = [];
  });

  test("normalizes client write rows and applies them under the route agent id", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/eliza/agents/agent-1/write",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({
            writes: [
              {
                table: "memories",
                operation: "insert",
                writeId: "write-1",
                retries: 0,
                row: {
                  id: "memory-1",
                  agent_id: "agent-1",
                  room_id: "room-1",
                  entity_id: "entity-1",
                  type: "messages",
                  content: { text: "hello" },
                  created_at: "2026-06-29T12:00:00.000Z",
                  ignored_column: "not persisted",
                },
              },
            ],
          }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      applied: 1,
      results: [{ writeId: "write-1", table: "memories", success: true }],
    });

    expect(requireServiceKey).toHaveBeenCalledTimes(1);
    expect(writeTransaction).toHaveBeenCalledTimes(1);
    expect(operations).toHaveLength(1);
    expect(operations[0].kind).toBe("insert");
    expect(operations[0].row).toMatchObject({
      id: "memory-1",
      agentId: "agent-1",
      roomId: "room-1",
      entityId: "entity-1",
      type: "messages",
      content: { text: "hello" },
    });
    expect(operations[0].row?.createdAt).toBeInstanceOf(Date);
    expect(operations[0].row).not.toHaveProperty("ignored_column");
  });

  test("updates existing rows before trying to insert an upsert payload", async () => {
    updateReturningRows = [{ id: "task-1" }];

    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/eliza/agents/agent-1/write",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({
            writes: [
              {
                table: "tasks",
                operation: "upsert",
                writeId: "write-2",
                row: {
                  id: "task-1",
                  agentId: "agent-1",
                  description: "updated",
                },
              },
            ],
          }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    expect(operations).toEqual([
      {
        kind: "update",
        set: {
          agentId: "agent-1",
          description: "updated",
        },
      },
    ]);
  });

  test("rejects rows scoped to a different agent before opening a transaction", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/eliza/agents/agent-1/write",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({
            writes: [
              {
                table: "relationships",
                operation: "insert",
                writeId: "write-3",
                row: {
                  id: "relationship-1",
                  agent_id: "agent-2",
                  source_entity_id: "entity-1",
                  target_entity_id: "entity-2",
                },
              },
            ],
          }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "validation_error",
    });
    expect(writeTransaction).not.toHaveBeenCalled();
  });

  test("deletes participant rows by entity, room, and route agent when no id is present", async () => {
    const response = await app.fetch(
      new Request(
        "https://api.example.test/api/v1/eliza/agents/agent-1/write",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Service-Key": "svc",
          },
          body: JSON.stringify({
            writes: [
              {
                table: "participants",
                operation: "delete",
                writeId: "write-4",
                row: {
                  entity_id: "entity-1",
                  room_id: "room-1",
                },
              },
            ],
          }),
        },
      ),
      { WAIFU_SERVICE_KEY: "svc" },
    );

    expect(response.status).toBe(200);
    expect(operations).toEqual([{ kind: "delete" }]);
  });
});
