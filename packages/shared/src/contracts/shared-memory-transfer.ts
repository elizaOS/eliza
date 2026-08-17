/**
 * Wire contract for the sealed Shared→Dedicated memory transfer (#20923
 * containment rebuild). One module defines the payload types, the boundary
 * validation schema, and the seal digest so the cloud exporter and the
 * container importer can never drift: the exporter computes the digest over
 * the rows it walked inside one MVCC snapshot, and the importer recomputes it
 * over the rows it actually received BEFORE any write — count and content
 * conservation are proven, not assumed from an HTTP status.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

/** The only vector width the Dedicated core schema can land (`dim_384`). */
export const SHARED_MEMORY_TRANSFER_VECTOR_DIMENSION = 384;
/** Hard cap per import request; large histories ship as multiple batches. */
export const SHARED_MEMORY_TRANSFER_MAX_ROWS = 500;
/** Provenance stamped into every transferred row's metadata. */
export const SHARED_MEMORY_TRANSFER_SOURCE = "shared-runtime-transfer";

const UuidSchema = z.uuid();

export const SealedMemoryExportRowSchema = z.object({
  id: UuidSchema,
  type: z.string().trim().min(1).max(64),
  created_at: z.iso.datetime(),
  content: z.record(z.string(), z.unknown()),
  entity_id: UuidSchema.nullable(),
  room_id: UuidSchema.nullable(),
  world_id: UuidSchema.nullable(),
  metadata: z
    .object({ source: z.literal(SHARED_MEMORY_TRANSFER_SOURCE) })
    .catchall(z.unknown()),
  embedding: z
    .object({
      dim_384: z
        .array(z.number().finite())
        .length(SHARED_MEMORY_TRANSFER_VECTOR_DIMENSION),
    })
    .optional(),
});

export const SealedExportSealSchema = z.object({
  row_count: z.number().int().min(0),
  embedding_count: z.number().int().min(0),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  source_agent_id: UuidSchema,
  organization_id: UuidSchema,
  user_id: UuidSchema,
});

export const SealedMemoryImportRequestSchema = z.object({
  seal: SealedExportSealSchema,
  rows: z
    .array(SealedMemoryExportRowSchema)
    .max(SHARED_MEMORY_TRANSFER_MAX_ROWS),
});

export type SealedMemoryExportRow = z.infer<typeof SealedMemoryExportRowSchema>;
export type SealedExportSeal = z.infer<typeof SealedExportSealSchema>;
export type SealedMemoryImportRequest = z.infer<
  typeof SealedMemoryImportRequestSchema
>;

/** A same-id row whose stored content differs from the transferred row. */
export interface SealedImportConflict {
  id: string;
  reason: "stored-row-mismatch";
}

/**
 * Importer response. `ok` is true only when every non-conflicting row landed
 * and conservation held; the caller must additionally verify
 * `imported + skipped_existing === rows.length` and never trust a bare 2xx.
 */
export interface SealedImportResponse {
  ok: boolean;
  imported: number;
  skipped_existing: number;
  embeddings_written: number;
  embeddings_skipped_verified: number;
  conflicts: SealedImportConflict[];
  digest_verified: boolean;
}

export const SealedImportResponseSchema = z.object({
  ok: z.literal(true),
  imported: z.number().int().min(0),
  skipped_existing: z.number().int().min(0),
  embeddings_written: z.number().int().min(0),
  embeddings_skipped_verified: z.number().int().min(0),
  conflicts: z.array(
    z.object({
      id: UuidSchema,
      reason: z.literal("stored-row-mismatch"),
    }),
  ),
  digest_verified: z.literal(true),
});

/** Canonical JSON used by seals and replay checks, independent of jsonb key order. */
export function canonicalSharedMemoryJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalSharedMemoryJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([key, entry]) =>
        `${JSON.stringify(key)}:${canonicalSharedMemoryJson(entry)}`,
    )
    .join(",")}}`;
}

function rowDigestLine(row: SealedMemoryExportRow): string {
  const contentHash = createHash("sha256")
    .update(canonicalSharedMemoryJson(row.content))
    .digest("hex");
  const metadataHash = createHash("sha256")
    .update(canonicalSharedMemoryJson(row.metadata))
    .digest("hex");
  const vectorHash = row.embedding
    ? createHash("sha256").update(row.embedding.dim_384.join(",")).digest("hex")
    : "-";
  return [
    row.id,
    row.created_at,
    row.type,
    row.entity_id ?? "-",
    row.room_id ?? "-",
    row.world_id ?? "-",
    contentHash,
    metadataHash,
    vectorHash,
  ].join("|");
}

/**
 * Order-sensitive digest over the exported rows. Exporter and importer MUST
 * both use this exact function; the request `seal.digest` binds the payload.
 */
export function computeSharedMemoryTransferDigest(
  rows: readonly SealedMemoryExportRow[],
): string {
  const chain = createHash("sha256");
  for (const row of rows) chain.update(rowDigestLine(row)).update("\n");
  chain.update(String(rows.length));
  return chain.digest("hex");
}
