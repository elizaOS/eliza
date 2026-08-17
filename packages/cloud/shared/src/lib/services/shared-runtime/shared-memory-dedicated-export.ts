/**
 * Pure transform from Shared-tier memory rows to the Dedicated runtime's core
 * schema shapes (`memories` + the 1:1 `embeddings` table), the data leg of a
 * Shared→Dedicated cutover. The transform is deliberately lossless where it
 * matters: `content` passes through byte-identical, every identity column
 * (id/agent/entity/room/world) and `created_at` are preserved exactly, and a
 * 384-dim vector maps onto the core `dim_384` column unchanged — so recall
 * over the transferred rows ranks identically to recall over the Shared rows.
 * Only provenance is added, in `metadata`, which the Shared row never used.
 * A vector whose dimension has no core column is reported, never silently
 * dropped into a wrong column.
 */

import type { SharedAgentMemoryRow } from "../../../db/schemas/shared-agent-memories";

/** Core `memories` row shape (schemas/memory.ts) the Dedicated adapter inserts. */
export interface DedicatedMemoryRow {
  id: string;
  type: string;
  created_at: Date;
  content: Record<string, unknown>;
  entity_id: string | null;
  agent_id: string;
  room_id: string | null;
  world_id: string | null;
  unique: boolean;
  metadata: Record<string, unknown>;
}

/** Core `embeddings` row leg for a transferred vector (schemas/embedding.ts). */
export interface DedicatedEmbeddingRow {
  memory_id: string;
  dim_384: number[];
}

export interface DedicatedMemoryExport {
  memory: DedicatedMemoryRow;
  embedding?: DedicatedEmbeddingRow;
  /** Set when a vector existed but no core dimension column fits it. */
  droppedEmbeddingDimension?: number;
}

/** Provenance marker stamped into every transferred row's metadata. */
export const SHARED_TRANSFER_METADATA = {
  source: "shared-runtime-transfer",
} as const;

/**
 * Transform one Shared row. Pure and total: every input row produces a
 * `memory` leg; the `embedding` leg exists only for vectors whose dimension
 * has a core column (bge-small's 384 today).
 */
export function toDedicatedMemoryExport(row: SharedAgentMemoryRow): DedicatedMemoryExport {
  const memory: DedicatedMemoryRow = {
    id: row.id,
    type: row.type,
    created_at: row.created_at,
    content: row.content as Record<string, unknown>,
    entity_id: row.entity_id,
    agent_id: row.agent_id,
    room_id: row.room_id,
    world_id: row.world_id,
    unique: true,
    metadata: { ...SHARED_TRANSFER_METADATA },
  };
  const vector = row.embedding;
  if (!Array.isArray(vector) || vector.length === 0) {
    return { memory };
  }
  if (vector.length !== 384) {
    // The Shared pipeline only writes bge-small 384-dim vectors; any other
    // length is an upstream anomaly the transfer surfaces, never papers over —
    // even when a core column for that dimension exists.
    return { memory, droppedEmbeddingDimension: vector.length };
  }
  return {
    memory,
    embedding: { memory_id: row.id, dim_384: vector },
  };
}

/** Transform a batch, preserving input order. */
export function toDedicatedMemoryExports(
  rows: readonly SharedAgentMemoryRow[],
): DedicatedMemoryExport[] {
  return rows.map((row) => toDedicatedMemoryExport(row));
}
