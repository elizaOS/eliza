/**
 * Sealed export of a tenant's Shared memory history for the Shared→Dedicated
 * cutover, rebuilt to the #20923 containment contract. The whole export reads
 * one REPEATABLE READ transaction (a single MVCC snapshot — concurrent turn
 * writes cannot yield a stale prefix that reports itself complete), and the
 * result carries the shared wire contract's transactional seal: counts plus
 * the order-sensitive digest the importer recomputes over what it actually
 * received before any write.
 *
 * Fidelity: `content` passes through byte-identical, identities and
 * `created_at` are preserved exactly, and vectors are exported VERBATIM. The
 * source→local agent remap is not guessed per row: the seal names the
 * `source_agent_id` once and the importer applies the documented remap against
 * it. A vector whose dimension has no importer column FAILS the export with a
 * typed error — never a dropped-but-successful result.
 */

import { ElizaError } from "@elizaos/core";
import {
  computeSharedMemoryTransferDigest,
  type SealedExportSeal,
  type SealedMemoryExportRow,
  SHARED_MEMORY_TRANSFER_SOURCE,
  SHARED_MEMORY_TRANSFER_VECTOR_DIMENSION,
} from "@elizaos/shared/contracts/shared-memory-transfer";
import { and, asc, eq, sql } from "drizzle-orm";
import { dbRead } from "../../../db/client";
import type { SharedAgentMemoryScope } from "../../../db/repositories/shared-agent-memories";
import {
  type SharedAgentMemoryRow,
  sharedAgentMemories,
} from "../../../db/schemas/shared-agent-memories";
import { sharedTodoStorageScope } from "./shared-runtime-storage-identity";

export const SHARED_MEMORY_EXPORT_ANOMALOUS_VECTOR = "SHARED_MEMORY_EXPORT_ANOMALOUS_VECTOR";
export const SEALED_EXPORT_PAGE = 200;

export interface SealedMemoryExport {
  seal: SealedExportSeal;
  rows: SealedMemoryExportRow[];
}

/** The identity triple of the agent whose Shared history is being exported. */
export interface SealedExportAgent {
  id: string;
  organization_id: string;
  user_id: string;
}

/**
 * The DB scope the Shared turn path writes this agent's memories under —
 * the todo-storage derivation of the serving agent id, mirroring
 * `sharedTurnMemoryStore` in shared-runtime-chat.
 */
export function sealedExportScopeForAgent(agent: SealedExportAgent): SharedAgentMemoryScope {
  return {
    organizationId: agent.organization_id,
    userId: agent.user_id,
    agentId: sharedTodoStorageScope({
      sourceAgentId: agent.id,
      ownerId: agent.user_id,
    }).agentId,
  };
}

function toExportRow(row: SharedAgentMemoryRow): SealedMemoryExportRow {
  const base: SealedMemoryExportRow = {
    id: row.id,
    type: row.type,
    created_at: row.created_at.toISOString(),
    content: row.content as Record<string, unknown>,
    entity_id: row.entity_id,
    room_id: row.room_id,
    world_id: row.world_id,
    metadata: { source: SHARED_MEMORY_TRANSFER_SOURCE },
  };
  const vector = row.embedding;
  if (!Array.isArray(vector) || vector.length === 0) return base;
  if (vector.length !== SHARED_MEMORY_TRANSFER_VECTOR_DIMENSION) {
    // Fail-closed: an anomalous stored vector is an upstream defect the
    // transfer must surface, never a row quietly exported without recall.
    throw new ElizaError("Shared memory export found a vector with no importable dimension", {
      code: SHARED_MEMORY_EXPORT_ANOMALOUS_VECTOR,
      context: { memoryId: row.id, dimension: vector.length },
    });
  }
  return { ...base, embedding: { dim_384: [...vector] } };
}

export interface SealedExportDeps {
  /** Test seam: runs `fn` against one consistent snapshot. Defaults to a
   *  REPEATABLE READ transaction on the shared read client. */
  withSnapshot?: <T>(fn: (tx: typeof dbRead) => Promise<T>) => Promise<T>;
}

async function defaultWithSnapshot<T>(fn: (tx: typeof dbRead) => Promise<T>): Promise<T> {
  return await dbRead.transaction(async (tx) => fn(tx as unknown as typeof dbRead), {
    isolationLevel: "repeatable read",
  });
}

/**
 * Export the agent's complete Shared history under one sealed snapshot. The
 * seal's counts and digest are computed from the rows actually walked, so the
 * seal IS the manifest of this exact payload.
 */
export async function exportSealedSharedMemories(
  agent: SealedExportAgent,
  deps: SealedExportDeps = {},
): Promise<SealedMemoryExport> {
  const scope = sealedExportScopeForAgent(agent);
  const withSnapshot = deps.withSnapshot ?? defaultWithSnapshot;

  const rows = await withSnapshot(async (tx) => {
    const out: SealedMemoryExportRow[] = [];
    let after: { createdAt: Date; id: string } | undefined;
    for (;;) {
      const page = await tx
        .select()
        .from(sharedAgentMemories)
        .where(
          and(
            eq(sharedAgentMemories.organization_id, scope.organizationId),
            eq(sharedAgentMemories.user_id, scope.userId),
            eq(sharedAgentMemories.agent_id, scope.agentId),
            ...(after
              ? [
                  sql`(${sharedAgentMemories.created_at}, ${sharedAgentMemories.id}) > (${after.createdAt}, ${after.id}::uuid)`,
                ]
              : []),
          ),
        )
        .orderBy(asc(sharedAgentMemories.created_at), asc(sharedAgentMemories.id))
        .limit(SEALED_EXPORT_PAGE);
      if (page.length === 0) break;
      for (const row of page) out.push(toExportRow(row));
      const last = page[page.length - 1] as SharedAgentMemoryRow;
      after = { createdAt: last.created_at, id: last.id };
      if (page.length < SEALED_EXPORT_PAGE) break;
    }
    return out;
  });

  return {
    seal: {
      row_count: rows.length,
      embedding_count: rows.filter((row) => row.embedding).length,
      digest: computeSharedMemoryTransferDigest(rows),
      source_agent_id: scope.agentId,
      organization_id: scope.organizationId,
      user_id: scope.userId,
    },
    rows,
  };
}
