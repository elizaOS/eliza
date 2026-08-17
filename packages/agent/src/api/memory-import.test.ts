/**
 * Contract tests for the bulk transferred-memory import surface. Deterministic:
 * the runtime is a recorder double so every assertion inspects exactly what
 * would be persisted — verbatim ids/timestamps/content/vectors, the deliberate
 * agent/authored-entity remap, scaffolding upserts with preserved ids, and
 * idempotent re-import. The wire shape mirrors the cloud-side fidelity
 * transform's output.
 */

import { describe, expect, test } from "vitest";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  importTransferredMemories,
  type MemoryImportItem,
  PostMemoryImportRequestSchema,
} from "./memory-import.ts";

const LOCAL_AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const SOURCE_AGENT = "8f1f7f72-0577-4b4a-b15b-229c751d5484";
const USER_ENTITY = "1d88c441-09a2-47ac-a8fd-a502884390c3";
const ROOM = "866e5ec5-5e66-4387-9333-6be867377d63";
const WORLD = "d04cf4d3-a60e-4209-ad78-d67d6a38ff95";

interface RecordedRuntime {
  runtime: AgentRuntime;
  createdMemories: Array<{ memory: Memory; tableName: string }>;
  worlds: Array<Record<string, unknown>>;
  rooms: Array<Record<string, unknown>>;
  entities: Array<Record<string, unknown>>;
  existingMemoryIds: Set<string>;
  existingEntityIds: Set<string>;
}

function recorderRuntime(): RecordedRuntime {
  const state: RecordedRuntime = {
    runtime: undefined as unknown as AgentRuntime,
    createdMemories: [],
    worlds: [],
    rooms: [],
    entities: [],
    existingMemoryIds: new Set(),
    existingEntityIds: new Set(),
  };
  state.runtime = {
    agentId: LOCAL_AGENT,
    ensureWorldExists: async (world: Record<string, unknown>) => {
      state.worlds.push(world);
    },
    ensureRoomExists: async (room: Record<string, unknown>) => {
      state.rooms.push(room);
    },
    getEntityById: async (id: string) =>
      state.existingEntityIds.has(id)
        ? { id, names: [], agentId: LOCAL_AGENT }
        : null,
    createEntity: async (entity: Record<string, unknown>) => {
      state.entities.push(entity);
      return true;
    },
    getMemoryById: async (id: string) =>
      state.existingMemoryIds.has(id) ? ({ id } as Memory) : null,
    adapter: {
      createMemories: async (
        batch: Array<{ memory: Memory; tableName: string }>,
      ) => {
        state.createdMemories.push(...batch);
        return batch.map((entry) => entry.memory.id as UUID);
      },
    },
  } as unknown as AgentRuntime;
  return state;
}

function transferItem(
  overrides: Partial<MemoryImportItem["memory"]> = {},
): MemoryImportItem {
  return {
    memory: {
      id: "96a23079-4032-49f3-ae44-d8a25471e473",
      type: "messages",
      created_at: "2026-08-17T03:44:45.770Z",
      content: { text: "hi", source: "shared-runtime", channelType: "DM" },
      entity_id: USER_ENTITY,
      agent_id: SOURCE_AGENT,
      room_id: ROOM,
      world_id: WORLD,
      unique: true,
      metadata: { source: "shared-runtime-transfer" },
      ...overrides,
    },
    embedding: {
      memory_id:
        (overrides.id as string) ?? "96a23079-4032-49f3-ae44-d8a25471e473",
      dim_384: Array.from({ length: 384 }, (_, i) => Math.sin(i) / 2),
    },
  };
}

describe("transferred memory import", () => {
  test("persists rows verbatim while remapping only the agent-owned identities", async () => {
    const state = recorderRuntime();
    const userRow = transferItem();
    const assistantRow = transferItem({
      id: "ada43714-95cf-4418-a568-a7ea232287fc",
      entity_id: SOURCE_AGENT,
      content: { text: "hello there", source: "shared-runtime" },
    });

    const result = await importTransferredMemories(state.runtime, [
      userRow,
      assistantRow,
    ]);

    expect(result).toEqual({
      ok: true,
      requested: 2,
      imported: 2,
      skippedExisting: 0,
      embeddingsWritten: 2,
      remappedAgentRows: 1,
    });

    const [user, assistant] = state.createdMemories;
    expect(user?.tableName).toBe("messages");
    expect(user?.memory.id).toBe(userRow.memory.id as UUID);
    expect(user?.memory.createdAt).toBe(Date.parse("2026-08-17T03:44:45.770Z"));
    expect(JSON.stringify(user?.memory.content)).toBe(
      JSON.stringify(userRow.memory.content),
    );
    expect(user?.memory.unique).toBe(true);
    expect(user?.memory.embedding).toEqual(
      userRow.embedding?.dim_384 as number[],
    );
    // The user's identity survives; the row now belongs to the local agent.
    expect(user?.memory.entityId).toBe(USER_ENTITY as UUID);
    expect(user?.memory.agentId).toBe(LOCAL_AGENT);
    expect(user?.memory.roomId).toBe(ROOM as UUID);
    expect(user?.memory.worldId).toBe(WORLD as UUID);
    // Assistant-authored rows remap entity_id: the source agent has no entity
    // row here, and recall attributes agent speech by the local agent id.
    expect(assistant?.memory.entityId).toBe(LOCAL_AGENT);
  });

  test("ensures scaffolding with transferred ids before any memory insert", async () => {
    const state = recorderRuntime();
    await importTransferredMemories(state.runtime, [transferItem()]);

    expect(state.worlds).toEqual([
      expect.objectContaining({ id: WORLD, agentId: LOCAL_AGENT }),
    ]);
    expect(state.rooms).toEqual([
      expect.objectContaining({
        id: ROOM,
        worldId: WORLD,
        source: "shared-runtime-transfer",
      }),
    ]);
    expect(state.entities).toEqual([
      expect.objectContaining({ id: USER_ENTITY, agentId: LOCAL_AGENT }),
    ]);
  });

  test("re-importing the same batch is a no-op reported as skippedExisting", async () => {
    const state = recorderRuntime();
    const item = transferItem();
    state.existingMemoryIds.add(item.memory.id);
    state.existingEntityIds.add(USER_ENTITY);

    const result = await importTransferredMemories(state.runtime, [item]);

    expect(result.imported).toBe(0);
    expect(result.skippedExisting).toBe(1);
    expect(state.createdMemories).toHaveLength(0);
    expect(state.entities).toHaveLength(0);
  });

  test("vector-less rows import without an embedding", async () => {
    const state = recorderRuntime();
    const item = transferItem();
    const vectorless: MemoryImportItem = { memory: item.memory };

    const result = await importTransferredMemories(state.runtime, [vectorless]);

    expect(result.embeddingsWritten).toBe(0);
    expect(state.createdMemories[0]?.memory.embedding).toBeUndefined();
  });

  test("schema rejects wrong-width vectors, bad uuids, and oversized batches", () => {
    const item = transferItem();
    expect(
      PostMemoryImportRequestSchema.safeParse({
        exports: [
          {
            memory: item.memory,
            embedding: { memory_id: item.memory.id, dim_384: [1, 2, 3] },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      PostMemoryImportRequestSchema.safeParse({
        exports: [{ memory: { ...item.memory, id: "not-a-uuid" } }],
      }).success,
    ).toBe(false);
    expect(
      PostMemoryImportRequestSchema.safeParse({
        exports: Array.from({ length: 501 }, () => ({ memory: item.memory })),
      }).success,
    ).toBe(false);
    expect(
      PostMemoryImportRequestSchema.safeParse({
        exports: [{ memory: item.memory }],
      }).success,
    ).toBe(true);
  });
});
