/**
 * Sealed bulk import of transferred Shared memories into this agent's
 * database — the container-side landing half of a Shared→Dedicated cutover,
 * rebuilt to the #20923 containment contract.
 *
 * Order of proof, all BEFORE any write: boundary validation (shared wire
 * schema), conservation (row/embedding counts against the seal and a digest
 * recompute over the received rows — transport truncation or tampering fails
 * here, never a bare-2xx pass), then id-conflict detection (an existing row
 * with DIFFERENT content is a 409 conflict that fails the whole request;
 * identical content is idempotent `skipped_existing`). Scaffolding rows
 * (worlds/rooms/entities) are created ONLY when absent — an existing row is
 * never overwritten. The writes land through the adapter's all-or-nothing
 * `createMemories` batch, with ids, timestamps, content, and vectors
 * verbatim; the ONLY mutation is the documented remap: rows authored by
 * `seal.source_agent_id` (and every row's owning agent) become THIS runtime's
 * agent id, since the source agent has no row here and recall scopes locally.
 */

import {
  type AgentRuntime,
  ChannelType,
  type Memory,
  type UUID,
} from "@elizaos/core";
import {
  computeSharedMemoryTransferDigest,
  type SealedImportConflict,
  type SealedImportResponse,
  type SealedMemoryImportRequest,
  SealedMemoryImportRequestSchema,
  SHARED_MEMORY_TRANSFER_SOURCE,
  sharedMemoryContentHash,
} from "@elizaos/shared/contracts/shared-memory-transfer";
import type { MemoryRouteContext } from "./memory-routes.ts";

/** Seal + 500 vectored rows is ~4KB/row; this bounds the request body. */
export const MEMORY_IMPORT_MAX_BODY_BYTES = 16 * 1024 * 1024;

export type SealedImportOutcome =
  | { status: 200; body: SealedImportResponse }
  | { status: 400 | 409; body: { ok: false; error: string; code: string } };

function failure(
  status: 400 | 409,
  code: string,
  error: string,
): SealedImportOutcome {
  return { status, body: { ok: false, error, code } };
}

async function ensureScaffoldingIfAbsent(
  runtime: AgentRuntime,
  request: SealedMemoryImportRequest,
): Promise<void> {
  const sourceAgentId = request.seal.source_agent_id;

  const worldIds = new Set<string>();
  const roomWorlds = new Map<string, string>();
  const transferWorldId = `${runtime.agentId}`;
  for (const row of request.rows) {
    const worldId = row.world_id ?? (row.room_id ? transferWorldId : undefined);
    if (worldId) worldIds.add(worldId);
    if (row.room_id) roomWorlds.set(row.room_id, worldId ?? transferWorldId);
  }
  for (const worldId of worldIds) {
    // Create-if-absent ONLY: an existing world (any name/metadata) is left
    // byte-untouched — the upsert path runs solely when nothing exists.
    const existing = (
      await runtime.adapter.getWorldsByIds([worldId as UUID])
    )?.[0];
    if (existing) continue;
    await runtime.ensureWorldExists({
      id: worldId as UUID,
      name: "Transferred shared history",
      agentId: runtime.agentId,
      metadata: { type: SHARED_MEMORY_TRANSFER_SOURCE },
    });
  }
  for (const [roomId, worldId] of roomWorlds) {
    const existing = await runtime.getRoom(roomId as UUID);
    if (existing) continue;
    await runtime.ensureRoomExists({
      id: roomId as UUID,
      name: "Transferred shared history",
      source: SHARED_MEMORY_TRANSFER_SOURCE,
      type: ChannelType.DM,
      worldId: worldId as UUID,
      metadata: { type: SHARED_MEMORY_TRANSFER_SOURCE },
    });
  }

  const entityIds = new Set<string>();
  for (const row of request.rows) {
    if (row.entity_id && row.entity_id !== sourceAgentId) {
      entityIds.add(row.entity_id);
    }
  }
  for (const entityId of entityIds) {
    const existing = await runtime.getEntityById(entityId as UUID);
    if (existing) continue;
    await runtime.createEntity({
      id: entityId as UUID,
      names: ["Transferred user"],
      agentId: runtime.agentId,
      metadata: { type: SHARED_MEMORY_TRANSFER_SOURCE },
    });
  }
}

/**
 * Validate, prove conservation, detect conflicts, then land the batch
 * atomically. Exported for direct unit coverage; the route is a thin shell.
 */
export async function importSealedMemories(
  runtime: AgentRuntime,
  raw: unknown,
): Promise<SealedImportOutcome> {
  const parsed = SealedMemoryImportRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    return failure(
      400,
      "IMPORT_INVALID_PAYLOAD",
      `${issue?.message ?? "Invalid import payload"}${path}`,
    );
  }
  const request = parsed.data;

  // Conservation BEFORE any write: counts and digest must match the seal.
  if (request.rows.length !== request.seal.row_count) {
    return failure(
      409,
      "IMPORT_ROW_COUNT_MISMATCH",
      `Seal claims ${request.seal.row_count} rows; request carries ${request.rows.length}`,
    );
  }
  const embeddingCount = request.rows.filter((row) => row.embedding).length;
  if (embeddingCount !== request.seal.embedding_count) {
    return failure(
      409,
      "IMPORT_EMBEDDING_COUNT_MISMATCH",
      `Seal claims ${request.seal.embedding_count} embeddings; request carries ${embeddingCount}`,
    );
  }
  const digest = computeSharedMemoryTransferDigest(request.rows);
  if (digest !== request.seal.digest) {
    return failure(
      409,
      "IMPORT_DIGEST_MISMATCH",
      "Recomputed payload digest does not match the seal",
    );
  }

  // Id-conflict pre-check BEFORE any write: same id + same content is an
  // idempotent replay; same id + different content fails the whole request.
  const conflicts: SealedImportConflict[] = [];
  const toImport: typeof request.rows = [];
  let skippedExisting = 0;
  for (const row of request.rows) {
    const existing = await runtime.getMemoryById(row.id as UUID);
    if (!existing) {
      toImport.push(row);
      continue;
    }
    if (
      sharedMemoryContentHash(existing.content) ===
      sharedMemoryContentHash(row.content)
    ) {
      skippedExisting += 1;
      continue;
    }
    conflicts.push({ id: row.id, reason: "content-mismatch" });
  }
  if (conflicts.length > 0) {
    return {
      status: 409,
      body: {
        ok: false,
        error: `Import refused: ${conflicts.length} id conflict(s) with different content`,
        code: "IMPORT_ID_CONFLICT",
      },
    };
  }

  await ensureScaffoldingIfAbsent(runtime, request);

  const sourceAgentId = request.seal.source_agent_id;
  const batch = toImport.map((row) => ({
    memory: {
      id: row.id as UUID,
      agentId: runtime.agentId,
      entityId: (row.entity_id === sourceAgentId || row.entity_id === null
        ? runtime.agentId
        : row.entity_id) as UUID,
      roomId: (row.room_id ?? undefined) as UUID,
      worldId: (row.world_id ??
        (row.room_id ? `${runtime.agentId}` : undefined)) as UUID | undefined,
      content: row.content as Memory["content"],
      metadata: row.metadata as Memory["metadata"],
      createdAt: Date.parse(row.created_at),
      ...(row.embedding ? { embedding: row.embedding.dim_384 } : {}),
    } as Memory,
    tableName: row.type,
    unique: true,
  }));

  // Adapter-direct all-or-nothing batch: preserves ids/timestamps/vectors
  // verbatim and skips the runtime wrapper's redaction and fact dedupe, which
  // would mutate transferred history.
  if (batch.length > 0) {
    await runtime.adapter.createMemories(batch);
  }

  return {
    status: 200,
    body: {
      ok: true,
      imported: batch.length,
      skipped_existing: skippedExisting,
      embeddings_written: batch.filter((entry) => entry.memory.embedding)
        .length,
      conflicts: [],
      digest_verified: true,
    },
  };
}

/** POST /api/memories/import — sealed transfer landing endpoint. */
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
  const outcome = await importSealedMemories(runtime, raw);
  json(res, outcome.body, outcome.status);
  return true;
}
