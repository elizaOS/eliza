/**
 * Contract tests for the sealed memory importer (#20923 rebuild).
 * Deterministic recorder-double runtime; every #20923 blocker is pinned:
 * digest/count conservation is proven BEFORE any write, id conflicts with
 * different content fail the whole request (identical content replays
 * idempotently), existing scaffolding is never overwritten, vectors and
 * ids/timestamps/content land verbatim through the all-or-nothing batch, and
 * the source-agent remap follows the seal's single authority.
 */

import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import {
  computeSharedMemoryTransferDigest,
  type SealedMemoryExportRow,
} from "@elizaos/shared/contracts/shared-memory-transfer";
import { describe, expect, it } from "vitest";
import { importSealedMemories } from "./memory-import.ts";

const LOCAL_AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const SOURCE_AGENT = "8f1f7f72-0577-4b4a-b15b-229c751d5484";
const USER_ENTITY = "1d88c441-09a2-47ac-a8fd-a502884390c3";
const ROOM = "866e5ec5-5e66-4387-9333-6be867377d63";
const WORLD = "d04cf4d3-a60e-4209-ad78-d67d6a38ff95";

interface RecordedRuntime {
  runtime: AgentRuntime;
  batches: Array<Array<{ memory: Memory; tableName: string }>>;
  batchConflictPolicies: Array<string | undefined>;
  worldsCreated: string[];
  roomsCreated: string[];
  entitiesCreated: string[];
  existingMemories: Map<string, Memory>;
  existingWorlds: Set<string>;
  existingRooms: Set<string>;
  existingEntities: Set<string>;
}

function recorderRuntime(): RecordedRuntime {
  const state: RecordedRuntime = {
    runtime: undefined as unknown as AgentRuntime,
    batches: [],
    batchConflictPolicies: [],
    worldsCreated: [],
    roomsCreated: [],
    entitiesCreated: [],
    existingMemories: new Map(),
    existingWorlds: new Set(),
    existingRooms: new Set(),
    existingEntities: new Set(),
  };
  state.runtime = {
    agentId: LOCAL_AGENT,
    getMemoryById: async (id: string) => state.existingMemories.get(id) ?? null,
    getRoom: async (id: string) =>
      state.existingRooms.has(id) ? { id } : null,
    getEntityById: async (id: string) =>
      state.existingEntities.has(id) ? { id } : null,
    ensureWorldExists: async (world: { id: string }) => {
      state.worldsCreated.push(world.id);
    },
    ensureRoomExists: async (room: { id: string }) => {
      state.roomsCreated.push(room.id);
    },
    createEntity: async (entity: { id: string }) => {
      state.entitiesCreated.push(entity.id);
      return true;
    },
    adapter: {
      getWorldsByIds: async (ids: string[]) =>
        ids.filter((id) => state.existingWorlds.has(id)).map((id) => ({ id })),
      createMemories: async (
        batch: Array<{ memory: Memory; tableName: string }>,
        options?: { onIdConflict?: string },
      ) => {
        state.batches.push(batch);
        state.batchConflictPolicies.push(options?.onIdConflict);
        return batch.map((entry) => entry.memory.id as UUID);
      },
    },
  } as unknown as AgentRuntime;
  return state;
}

function exportRow(
  index: number,
  overrides: Partial<SealedMemoryExportRow> = {},
): SealedMemoryExportRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    type: "messages",
    created_at: "2026-08-17T03:44:45.770Z",
    content: { text: `m${index}`, source: "shared-runtime" },
    entity_id: USER_ENTITY,
    room_id: ROOM,
    world_id: WORLD,
    metadata: { source: "shared-runtime-transfer" },
    embedding: {
      dim_384: Array.from({ length: 384 }, (_, i) => Math.sin(i + index) / 2),
    },
    ...overrides,
  };
}

function sealedRequest(rows: SealedMemoryExportRow[]) {
  return {
    seal: {
      row_count: rows.length,
      embedding_count: rows.filter((row) => row.embedding).length,
      digest: computeSharedMemoryTransferDigest(rows),
      source_agent_id: SOURCE_AGENT,
      organization_id: "75ae457b-801f-43e1-9d95-5585147655cd",
      user_id: "f210269b-8148-428b-8c24-91da4c95c727",
    },
    rows,
  };
}

describe("sealed memory import", () => {
  it("lands rows verbatim in one atomic batch with the documented remap", async () => {
    const state = recorderRuntime();
    const rows = [
      exportRow(0),
      exportRow(1, {
        entity_id: SOURCE_AGENT,
        content: { text: "agent reply" },
      }),
    ];
    const outcome = await importSealedMemories(
      state.runtime,
      sealedRequest(rows),
    );

    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({
      ok: true,
      imported: 2,
      skipped_existing: 0,
      embeddings_written: 2,
      embeddings_skipped_verified: 0,
      digest_verified: true,
    });
    expect(state.batches).toHaveLength(1);
    expect(state.batchConflictPolicies).toEqual(["error"]);
    const [user, agent] = state.batches[0] ?? [];
    expect(user?.memory.id).toBe(rows[0]?.id as UUID);
    expect(user?.memory.createdAt).toBe(Date.parse("2026-08-17T03:44:45.770Z"));
    expect(JSON.stringify(user?.memory.content)).toBe(
      JSON.stringify(rows[0]?.content),
    );
    expect(user?.memory.embedding).toEqual(rows[0]?.embedding?.dim_384);
    expect(user?.memory.entityId).toBe(USER_ENTITY as UUID);
    expect(user?.memory.agentId).toBe(LOCAL_AGENT);
    // Only the seal's source agent id remaps; the seal is the single authority.
    expect(agent?.memory.entityId).toBe(LOCAL_AGENT);
  });

  it("proves digest conservation before any write", async () => {
    const state = recorderRuntime();
    const rows = [exportRow(0)];
    const request = sealedRequest(rows);
    request.rows[0] = exportRow(0, { content: { text: "tampered" } });

    const outcome = await importSealedMemories(state.runtime, request);
    expect(outcome.status).toBe(409);
    expect(outcome.body).toMatchObject({
      ok: false,
      code: "IMPORT_DIGEST_MISMATCH",
    });
    expect(state.batches).toHaveLength(0);
    expect(state.worldsCreated).toHaveLength(0);
  });

  it("fails count mismatches against the seal before any write", async () => {
    const state = recorderRuntime();
    const rows = [exportRow(0), exportRow(1)];
    const request = sealedRequest(rows);
    request.seal.row_count = 3;
    const outcome = await importSealedMemories(state.runtime, request);
    expect(outcome.status).toBe(409);
    expect(outcome.body).toMatchObject({ code: "IMPORT_ROW_COUNT_MISMATCH" });
    expect(state.batches).toHaveLength(0);
  });

  it("an existing id with DIFFERENT content fails the whole request as a conflict", async () => {
    const state = recorderRuntime();
    const rows = [exportRow(0), exportRow(1)];
    state.existingMemories.set(
      rows[0]?.id as string,
      {
        id: rows[0]?.id,
        content: { text: "something else entirely" },
      } as Memory,
    );

    const outcome = await importSealedMemories(
      state.runtime,
      sealedRequest(rows),
    );
    expect(outcome.status).toBe(409);
    expect(outcome.body).toMatchObject({
      ok: false,
      code: "IMPORT_ID_CONFLICT",
    });
    // Fail-closed: the non-conflicting row must NOT have been written either.
    expect(state.batches).toHaveLength(0);
  });

  it("an existing id with IDENTICAL content replays idempotently", async () => {
    const state = recorderRuntime();
    const rows = [exportRow(0), exportRow(1)];
    state.existingMemories.set(
      rows[0]?.id as string,
      {
        id: rows[0]?.id,
        type: rows[0]?.type,
        agentId: LOCAL_AGENT,
        entityId: rows[0]?.entity_id,
        roomId: rows[0]?.room_id,
        worldId: rows[0]?.world_id,
        createdAt: Date.parse(rows[0]?.created_at as string),
        content: rows[0]?.content,
        metadata: rows[0]?.metadata,
        embedding: rows[0]?.embedding?.dim_384,
      } as Memory,
    );

    const outcome = await importSealedMemories(
      state.runtime,
      sealedRequest(rows),
    );
    expect(outcome.status).toBe(200);
    expect(outcome.body).toMatchObject({
      ok: true,
      imported: 1,
      skipped_existing: 1,
      embeddings_written: 1,
      embeddings_skipped_verified: 1,
    });
    expect(state.batches[0]).toHaveLength(1);
    expect(state.batches[0]?.[0]?.memory.id).toBe(rows[1]?.id as UUID);
  });

  it("refuses same-content replays when any persisted field differs", async () => {
    const state = recorderRuntime();
    const transferred = exportRow(0);
    state.existingMemories.set(transferred.id, {
      id: transferred.id as UUID,
      type: transferred.type,
      agentId: LOCAL_AGENT,
      entityId: transferred.entity_id as UUID,
      roomId: transferred.room_id as UUID,
      worldId: transferred.world_id as UUID,
      createdAt: Date.parse(transferred.created_at),
      content: transferred.content as Memory["content"],
      metadata: transferred.metadata as Memory["metadata"],
      embedding: transferred.embedding?.dim_384.map((value, index) =>
        index === 0 ? value + 0.01 : value,
      ),
    } as Memory);

    const outcome = await importSealedMemories(
      state.runtime,
      sealedRequest([transferred]),
    );
    expect(outcome.status).toBe(409);
    expect(outcome.body).toMatchObject({ code: "IMPORT_ID_CONFLICT" });
    expect(state.batches).toHaveLength(0);
  });

  it("never overwrites existing scaffolding; absent scaffolding is created", async () => {
    const state = recorderRuntime();
    state.existingWorlds.add(WORLD);
    state.existingEntities.add(USER_ENTITY);

    const outcome = await importSealedMemories(
      state.runtime,
      sealedRequest([exportRow(0)]),
    );
    expect(outcome.status).toBe(200);
    // Existing world + entity untouched; only the absent room is created.
    expect(state.worldsCreated).toHaveLength(0);
    expect(state.entitiesCreated).toHaveLength(0);
    expect(state.roomsCreated).toEqual([ROOM]);
  });

  it("rejects malformed payloads at the boundary", async () => {
    const state = recorderRuntime();
    const bad = sealedRequest([exportRow(0)]);
    (bad.rows[0] as { embedding: unknown }).embedding = { dim_384: [1, 2, 3] };
    const outcome = await importSealedMemories(state.runtime, bad);
    expect(outcome.status).toBe(400);
    expect(outcome.body).toMatchObject({ code: "IMPORT_INVALID_PAYLOAD" });
    expect(state.batches).toHaveLength(0);
  });

  it("vectors pass through without rounding", async () => {
    const state = recorderRuntime();
    const precise = Array.from(
      { length: 384 },
      (_, i) => 0.123456789 + i * 1e-9,
    );
    const rows = [exportRow(0, { embedding: { dim_384: precise } })];
    await importSealedMemories(state.runtime, sealedRequest(rows));
    expect(state.batches[0]?.[0]?.memory.embedding).toEqual(precise);
  });
});
