/**
 * Bulk lossless import of transferred memory rows into this agent's database —
 * the container-side landing half of a Shared→Dedicated cutover. The cloud
 * control plane exports `shared_agent_memories` rows through its fidelity
 * transform and POSTs them here once the container is reachable; the wire shape
 * mirrors that transform's output (snake_case core `memories` row + optional
 * `dim_384` embedding leg).
 *
 * Fidelity invariants: memory ids, `created_at`, `content`, `metadata`,
 * `unique`, and vectors are persisted verbatim, so writes go through
 * `runtime.adapter.createMemory` directly — the runtime wrapper's secret
 * redaction and fact dedupe would mutate transferred history. Two identities
 * are deliberately remapped: every row's `agent_id`, and the `entity_id` of
 * rows authored by the source agent, become THIS runtime's agent id — the
 * source agent id has no entity/agent row here (FK), and recall scopes by the
 * local agent id. Referenced worlds/rooms/entities are upserted first with
 * their transferred ids so foreign keys hold and cross-row identity survives.
 * Re-POSTing a batch is a no-op per already-present id (adapter conflict
 * skip + a pre-check that reports `skippedExisting` honestly).
 */

import {
  type AgentRuntime,
  ChannelType,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { z } from "zod";
import type { MemoryRouteContext } from "./memory-routes.ts";

export const MEMORY_IMPORT_SOURCE = "shared-runtime-transfer";
export const MEMORY_IMPORT_MAX_BATCH = 500;
/** Vectored rows are ~4KB each; 500 rows plus content fits well inside this. */
export const MEMORY_IMPORT_MAX_BODY_BYTES = 16 * 1024 * 1024;

const UuidSchema = z.uuid();

const ImportMemorySchema = z.object({
  id: UuidSchema,
  type: z.string().trim().min(1).max(64),
  created_at: z.iso.datetime(),
  content: z.record(z.string(), z.unknown()),
  entity_id: UuidSchema.nullable(),
  agent_id: UuidSchema,
  room_id: UuidSchema.nullable(),
  world_id: UuidSchema.nullable(),
  unique: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
});

const ImportEmbeddingSchema = z.object({
  memory_id: UuidSchema,
  dim_384: z.array(z.number().finite()).length(384),
});

const ImportItemSchema = z.object({
  memory: ImportMemorySchema,
  embedding: ImportEmbeddingSchema.optional(),
});

export const PostMemoryImportRequestSchema = z.object({
  exports: z.array(ImportItemSchema).min(1).max(MEMORY_IMPORT_MAX_BATCH),
});

export type MemoryImportItem = z.infer<typeof ImportItemSchema>;

export interface MemoryImportResult {
  ok: true;
  requested: number;
  imported: number;
  skippedExisting: number;
  embeddingsWritten: number;
  remappedAgentRows: number;
}

function transferWorldId(runtime: AgentRuntime): UUID {
  // Deterministic per agent so retries and later batches converge on one world.
  return `${runtime.agentId}` as UUID;
}

async function ensureScaffolding(
  runtime: AgentRuntime,
  items: MemoryImportItem[],
): Promise<Map<string, UUID>> {
  const sourceAgentIds = new Set(items.map((item) => item.memory.agent_id));

  const worldIds = new Set<string>();
  for (const item of items) {
    if (item.memory.world_id) worldIds.add(item.memory.world_id);
    else if (item.memory.room_id) worldIds.add(transferWorldId(runtime));
  }
  for (const worldId of worldIds) {
    await runtime.ensureWorldExists({
      id: worldId as UUID,
      name: "Transferred shared history",
      agentId: runtime.agentId,
      metadata: { type: MEMORY_IMPORT_SOURCE },
    });
  }

  // room id → effective world id, preserving the transferred pairing.
  const roomWorlds = new Map<string, UUID>();
  for (const item of items) {
    if (!item.memory.room_id) continue;
    const worldId = (item.memory.world_id ?? transferWorldId(runtime)) as UUID;
    roomWorlds.set(item.memory.room_id, worldId);
  }
  for (const [roomId, worldId] of roomWorlds) {
    await runtime.ensureRoomExists({
      id: roomId as UUID,
      name: "Transferred shared history",
      source: MEMORY_IMPORT_SOURCE,
      type: ChannelType.DM,
      worldId,
      metadata: { type: MEMORY_IMPORT_SOURCE },
    });
  }

  const entityIds = new Set<string>();
  for (const item of items) {
    const entityId = item.memory.entity_id;
    if (entityId && !sourceAgentIds.has(entityId)) entityIds.add(entityId);
  }
  for (const entityId of entityIds) {
    const existing = await runtime.getEntityById(entityId as UUID);
    if (existing) continue;
    await runtime.createEntity({
      id: entityId as UUID,
      names: ["Transferred user"],
      agentId: runtime.agentId,
      metadata: { type: MEMORY_IMPORT_SOURCE },
    });
  }

  return roomWorlds;
}

export async function importTransferredMemories(
  runtime: AgentRuntime,
  items: MemoryImportItem[],
): Promise<MemoryImportResult> {
  const sourceAgentIds = new Set(items.map((item) => item.memory.agent_id));
  const roomWorlds = await ensureScaffolding(runtime, items);

  let imported = 0;
  let skippedExisting = 0;
  let embeddingsWritten = 0;
  let remappedAgentRows = 0;

  for (const item of items) {
    const row = item.memory;
    const existing = await runtime.getMemoryById(row.id as UUID);
    if (existing) {
      skippedExisting += 1;
      continue;
    }

    const authoredBySourceAgent =
      row.entity_id !== null && sourceAgentIds.has(row.entity_id);
    if (authoredBySourceAgent) remappedAgentRows += 1;

    const memory: Memory = {
      id: row.id as UUID,
      agentId: runtime.agentId,
      entityId: (authoredBySourceAgent
        ? runtime.agentId
        : (row.entity_id ?? runtime.agentId)) as UUID,
      roomId: (row.room_id ?? undefined) as UUID,
      worldId: row.room_id
        ? roomWorlds.get(row.room_id)
        : ((row.world_id ?? undefined) as UUID | undefined),
      content: row.content as Memory["content"],
      metadata: row.metadata as Memory["metadata"],
      unique: row.unique,
      createdAt: Date.parse(row.created_at),
      ...(item.embedding ? { embedding: item.embedding.dim_384 } : {}),
    };

    // Adapter-direct on purpose: preserves id/createdAt/unique verbatim,
    // skips the runtime wrapper's content redaction and fact dedupe, and is
    // idempotent via the memories-table conflict skip.
    await runtime.adapter.createMemories([
      { memory, tableName: row.type, unique: row.unique },
    ]);
    imported += 1;
    if (item.embedding) embeddingsWritten += 1;
  }

  return {
    ok: true,
    requested: items.length,
    imported,
    skippedExisting,
    embeddingsWritten,
    remappedAgentRows,
  };
}

/** POST /api/memories/import — validates the batch and lands it losslessly. */
export async function handleMemoryImportRoute(
  ctx: MemoryRouteContext,
): Promise<boolean> {
  const { req, res, runtime, json, error, readJsonBody } = ctx;
  if (!runtime) {
    error(res, "Agent runtime is not available", 503);
    return true;
  }

  const raw = await readJsonBody<Record<string, unknown>>(req, res, {
    maxBytes: MEMORY_IMPORT_MAX_BODY_BYTES,
  });
  if (raw === null) return true;

  const parsed = PostMemoryImportRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    error(res, `${issue?.message ?? "Invalid import payload"}${path}`, 400);
    return true;
  }

  const mismatched = parsed.data.exports.find(
    (item) => item.embedding && item.embedding.memory_id !== item.memory.id,
  );
  if (mismatched) {
    error(
      res,
      `embedding.memory_id does not match memory.id for ${mismatched.memory.id}`,
      400,
    );
    return true;
  }

  const result = await importTransferredMemories(runtime, parsed.data.exports);
  json(res, result);
  return true;
}
