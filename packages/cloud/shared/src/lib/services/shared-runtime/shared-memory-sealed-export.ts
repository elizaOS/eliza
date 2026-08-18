/**
 * Fenced sealed export — the source leg of Shared→Dedicated memory promotion
 * (round 3, #21090 review).
 *
 * Preconditions are structural, not conventional: the scope's active epoch
 * must already be `fenced` (writers are refused at the store), so the keyset
 * scan cannot race a commit. The whole read still runs in one REPEATABLE READ
 * transaction as defense in depth. The result is the full row set plus a
 * SIGNED whole-export seal binding {epoch, scope, count, order-sensitive
 * digest, vector dimension}; the destination re-derives everything and binds
 * finalization to this exact seal.
 */
import {
  computeSharedMemoryTransferDigest,
  type SealedExportSeal,
  type SealedMemoryExportRow,
  signSeal,
} from "@elizaos/shared/contracts/shared-memory-transfer";
import { ElizaError } from "@elizaos/core";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { dbRead } from "../../../db/client";
import {
  type SharedAgentMemoryScope,
} from "../../../db/repositories/shared-agent-memories";
import { getActiveEpoch } from "../../../db/repositories/shared-transfer-epochs";
import { sharedAgentMemories } from "../../../db/schemas/shared-agent-memories";

export const SHARED_MEMORY_EXPORT_NOT_FENCED = "SHARED_MEMORY_EXPORT_NOT_FENCED";
export const SHARED_MEMORY_EXPORT_MIXED_DIMENSIONS = "SHARED_MEMORY_EXPORT_MIXED_DIMENSIONS";

const PAGE_SIZE = 500;

export interface SealedSharedMemoryExport {
  seal: SealedExportSeal;
  rows: SealedMemoryExportRow[];
}

/** Env var NAME for the seal HMAC key; the value never enters logs or seals. */
export const SEAL_KEY_ENV = "ELIZA_MEMORY_TRANSFER_SEAL_KEY";

export async function exportSealedSharedMemories(
  scope: SharedAgentMemoryScope,
  sealKey: string,
): Promise<SealedSharedMemoryExport> {
  const active = await getActiveEpoch(scope);
  if (!active || active.state !== "fenced") {
    throw new ElizaError("Sealed export requires a fenced promotion epoch", {
      code: SHARED_MEMORY_EXPORT_NOT_FENCED,
      context: { state: active?.state ?? "none" },
    });
  }

  const rows: SealedMemoryExportRow[] = [];
  let dimension: number | null = null;

  await dbRead.transaction(
    async (tx) => {
      let cursor: { created_at: Date; id: string } | null = null;
      for (;;) {
        const where = and(
          eq(sharedAgentMemories.organization_id, scope.organizationId),
          eq(sharedAgentMemories.user_id, scope.userId),
          eq(sharedAgentMemories.agent_id, scope.agentId),
          // Keyset over the stable (created_at, id) order; tuple-compare
          // emulated so equal timestamps across a page boundary are not
          // skipped: (created_at > c) OR (created_at = c AND id > last_id).
          ...(cursor
            ? [
                or(
                  gt(sharedAgentMemories.created_at, cursor.created_at),
                  and(
                    eq(sharedAgentMemories.created_at, cursor.created_at),
                    gt(sharedAgentMemories.id, cursor.id),
                  ),
                ),
              ]
            : []),
        );
        const page = await tx
          .select()
          .from(sharedAgentMemories)
          .where(where)
          .orderBy(asc(sharedAgentMemories.created_at), asc(sharedAgentMemories.id))
          .limit(PAGE_SIZE);
        for (const row of page) {
          const vector = row.embedding ?? null;
          if (vector) {
            if (dimension === null) dimension = vector.length;
            else if (dimension !== vector.length) {
              throw new ElizaError("Export found mixed embedding dimensions", {
                code: SHARED_MEMORY_EXPORT_MIXED_DIMENSIONS,
                context: { expected: dimension, found: vector.length, id: row.id },
              });
            }
          }
          rows.push({
            id: row.id,
            type: row.type,
            created_at: row.created_at.toISOString(),
            content: row.content,
            entity_id: row.entity_id,
            agent_id: row.agent_id,
            room_id: row.room_id,
            world_id: row.world_id,
            unique: false,
            metadata: {},
            embedding: vector,
          });
        }
        if (page.length < PAGE_SIZE) break;
        const last = page[page.length - 1]!;
        cursor = { created_at: last.created_at, id: last.id };
      }
    },
    { isolationLevel: "repeatable read" },
  );

  const digest = await computeSharedMemoryTransferDigest(rows);
  const body = {
    version: 3 as const,
    epoch: active.epoch,
    source_agent_id: scope.agentId,
    scope: `${scope.organizationId}:${scope.userId}:${scope.agentId}`,
    row_count: rows.length,
    digest,
    vector_dimension: dimension,
    exported_at: new Date().toISOString(),
  };
  const signature = await signSeal(body, sealKey);
  return { seal: { ...body, signature }, rows };
}
