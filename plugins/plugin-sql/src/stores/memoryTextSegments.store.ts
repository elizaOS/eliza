/**
 * Segmented-content store for the `memory_text_segments` table (#25140):
 * atomic publication of immutable UTF-8 source segments alongside a bounded
 * parent descriptor, generation-fenced replacement, and authorized byte-window
 * page reads that never materialize the parent content or join embeddings.
 * Consumed by BaseDrizzleAdapter; segmented parents carry their descriptors in
 * `metadata.segmentation[<fieldKey>]`, never the source bytes.
 */

import { createHash } from "node:crypto";
import {
  buildSegmentationRevision,
  type ComputedMemorySegment,
  clampPageWindow,
  ElizaError,
  encodeUtf8Strict,
  type MemorySegmentField,
  memorySegmentFieldKey,
  segmentMemoryContent,
  type UUID,
} from "@elizaos/core";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { memoryTextSegmentTable } from "../schema/index";
import type { DrizzleDatabase } from "../types";

/** Serialized descriptor row shape as stored on parent metadata. */
export interface StoredSegmentationDescriptor {
  v: 1;
  field: MemorySegmentField;
  encoding: "utf-8";
  segmentBytes: number;
  totalBytes: number;
  totalSha256: string;
  segmentCount: number;
  generation: string;
  revision: string;
}

type ParentRow = {
  id: UUID;
  entityId: UUID | null;
  roomId: UUID | null;
  worldId: UUID | null;
  agentId: UUID;
  metadata: unknown;
};

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readDescriptors(
  metadata: unknown,
): Map<string, StoredSegmentationDescriptor> {
  const out = new Map<string, StoredSegmentationDescriptor>();
  if (!metadata || typeof metadata !== "object") return out;
  const segmentation = (metadata as { segmentation?: unknown }).segmentation;
  if (!segmentation || typeof segmentation !== "object") return out;
  for (const [key, value] of Object.entries(
    segmentation as Record<string, unknown>,
  )) {
    if (
      value &&
      typeof value === "object" &&
      (value as { v?: unknown }).v === 1
    ) {
      out.set(key, value as StoredSegmentationDescriptor);
    }
  }
  return out;
}

/**
 * Splits `text` and inserts the bounded parent descriptor + all generation
 * segments for `field` inside the caller's transaction. The caller MUST write
 * the returned metadata onto the parent row in the SAME transaction (or pass a
 * parent that already carries it), so failure leaves neither parent nor
 * orphaned segments. When the parent already carries a descriptor for this
 * field, a fresh generation replaces it and prior-generation rows for this
 * parent are deleted in the same transaction.
 *
 * Returns the metadata object the parent row must persist.
 */
export async function publishSegmentedFieldInTransaction(params: {
  tx: DrizzleDatabase;
  parentId: UUID;
  entityId: UUID | null;
  field: MemorySegmentField;
  text: string;
  existingMetadata: unknown;
  segmentBytes?: number;
}): Promise<Record<string, unknown>> {
  const { tx, parentId, field, text } = params;
  const metadata =
    params.existingMetadata && typeof params.existingMetadata === "object"
      ? { ...(params.existingMetadata as Record<string, unknown>) }
      : {};
  const segmentation = {
    ...((metadata.segmentation as Record<string, unknown> | undefined) ?? {}),
  };

  const descriptors = readDescriptors(metadata);
  const prior = descriptors.get(memorySegmentFieldKey(field));

  const computed = segmentMemoryContent(text, field, {
    ...(params.segmentBytes ? { segmentBytes: params.segmentBytes } : {}),
    // A fresh generation every publication keeps immutability even if the
    // text is byte-identical to the prior generation.
  });

  // Generation UUID must be a valid uuid for the column; segmentMemoryContent
  // mints one via randomUUID.
  await insertSegments(
    tx,
    parentId,
    computed.segments,
    computed.descriptor.generation,
  );

  segmentation[memorySegmentFieldKey(field)] = computed.descriptor;
  metadata.segmentation = segmentation;

  // Retire prior generations of this parent (any field) atomically with the
  // new publication: delete every segment row not belonging to a live
  // descriptor generation after the parent metadata update is staged.
  const liveGenerations = new Set(
    [...readDescriptors(metadata).values()].map((d) => d.generation),
  );
  await deleteStaleGenerations(
    tx,
    parentId,
    liveGenerations,
    prior?.generation,
  );

  return metadata;
}

async function insertSegments(
  tx: DrizzleDatabase,
  parentId: UUID,
  segments: ComputedMemorySegment[],
  generation: string,
): Promise<void> {
  if (segments.length === 0) return;
  await tx.insert(memoryTextSegmentTable).values(
    segments.map((segment) => ({
      parentId,
      generation,
      segmentIndex: segment.index,
      byteStart: segment.byteStart,
      byteEnd: segment.byteEnd,
      text: segment.text,
      segmentSha256: segment.sha256,
    })),
  );
}

async function deleteStaleGenerations(
  tx: DrizzleDatabase,
  parentId: UUID,
  liveGenerations: Set<string>,
  priorGeneration?: string,
): Promise<void> {
  // Delete rows of any retired generation. With only live generations kept,
  // the invariant "every segment row belongs to the descriptor's generation"
  // holds at read time.
  const live = [...liveGenerations];
  if (live.length === 0) return;
  // Guard: prior generation of this field is retired unless it is still live.
  if (priorGeneration && !live.includes(priorGeneration)) {
    await tx
      .delete(memoryTextSegmentTable)
      .where(
        and(
          eq(memoryTextSegmentTable.parentId, parentId),
          eq(memoryTextSegmentTable.generation, priorGeneration),
        ),
      );
  }
}

/**
 * Authorized byte-window page read over a segmented field. Throws typed
 * ElizaErrors: MEMORY_CONTENT_REINDEX_REQUIRED for legacy large unsegmented
 * rows, MEMORY_CONTENT_STALE_REVISION for continuation mismatches, and
 * MEMORY_CONTENT_NOT_SEGMENTED when the field has no descriptor and the
 * inline value is within the segmentation threshold (caller should fall back
 * to the ordinary small-row read).
 */
export async function readMemoryContentPage(params: {
  db: DrizzleDatabase;
  memoryId: UUID;
  field: MemorySegmentField;
  byteStart: number;
  byteLimit?: number;
  expectedRevision?: string;
}): Promise<{
  text: string;
  start: number;
  end: number;
  total: number;
  sliceSha256: string;
  sourceSha256: string;
  revision: string;
  completeness: "partial-recoverable" | "complete";
} | null> {
  const { db, memoryId, field } = params;

  const parentRows = await db.execute(sql`
    SELECT id, metadata FROM memories WHERE id = ${memoryId} LIMIT 1
  `);
  const parentRow = (parentRows.rows as ParentRow[])[0];
  if (!parentRow) return null;

  const descriptor = readDescriptors(parentRow.metadata).get(
    memorySegmentFieldKey(field),
  );

  if (!descriptor) {
    // No descriptor: either the row is small (caller falls back to the normal
    // read) or it is a legacy large unsegmented row (typed reindex error).
    const inlineBytes = await db.execute(sql`
      SELECT octet_length(COALESCE(content->>'text','')) AS text_bytes,
             (
               SELECT COALESCE(sum(octet_length(a->>'text')), 0)
               FROM jsonb_array_elements(COALESCE(content->'attachments','[]'::jsonb)) a
               WHERE ${
                 field.kind === "attachment.text"
                   ? sql`a->>'id' = ${field.attachmentId}`
                   : sql`false`
}
             ) AS attachment_bytes
      FROM memories WHERE id = ${memoryId}
    `);
    const row = (
      inlineBytes.rows as Array<{
        text_bytes: number;
        attachment_bytes: number;
      }>
    )[0];
    const fieldBytes =
      field.kind === "attachment.text"
        ? row?.attachment_bytes
        : row?.text_bytes;
    if (fieldBytes !== undefined && fieldBytes > 256 * 1024) {
      throw new ElizaError(
        "Legacy large unsegmented content requires an authorized reindex before paged reads",
        {
          code: "MEMORY_CONTENT_REINDEX_REQUIRED",
          context: { memoryId, fieldKind: field.kind, fieldBytes },
        },
      );
    }
    return null;
  }

  if (params.byteStart > 0 && !params.expectedRevision) {
    throw new ElizaError(
      "Stored-content continuation requires expectedRevision.",
      {
        code: "MEMORY_CONTENT_EXPECTED_REVISION_REQUIRED",
        context: { memoryId },
      },
    );
  }
  if (
    params.expectedRevision &&
    params.expectedRevision !== descriptor.revision
  ) {
    throw new ElizaError(
      "The stored content changed before this page could be read.",
      {
        code: "MEMORY_CONTENT_STALE_REVISION",
        context: { currentRevision: descriptor.revision },
      },
    );
  }

  const window = clampPageWindow(
    descriptor.totalBytes,
    params.byteStart,
    params.byteLimit,
  );

  // Fetch only segments intersecting the window, ordered by range.
  const segmentRows = await db
    .select({
      byteStart: memoryTextSegmentTable.byteStart,
      byteEnd: memoryTextSegmentTable.byteEnd,
      text: memoryTextSegmentTable.text,
      segmentSha256: memoryTextSegmentTable.segmentSha256,
    })
    .from(memoryTextSegmentTable)
    .where(
      and(
        eq(memoryTextSegmentTable.parentId, memoryId),
        eq(memoryTextSegmentTable.generation, descriptor.generation),
        // Intersects [window.start, window.end): start < windowEnd AND end > windowStart
        lt(memoryTextSegmentTable.byteStart, window.end),
        gt(memoryTextSegmentTable.byteEnd, window.start),
      ),
    )
    .orderBy(asc(memoryTextSegmentTable.byteStart));

  if (segmentRows.length === 0) {
    throw new ElizaError(
      "Segmented content descriptor does not match its segment rows",
      {
        code: "MEMORY_SEGMENT_DESCRIPTOR_DRIFT",
        context: { memoryId, generation: descriptor.generation },
      },
    );
  }

  // Byte-exact assembly of the window across segment boundaries.
  const parts: Uint8Array[] = [];
  for (const row of segmentRows) {
    const segBytes = encodeUtf8Strict(row.text);
    if (segBytes.length !== row.byteEnd - row.byteStart) {
      throw new ElizaError(
        "Stored segment byte length does not match its range",
        {
          code: "MEMORY_SEGMENT_DESCRIPTOR_DRIFT",
          context: {
            memoryId,
            generation: descriptor.generation,
            byteStart: row.byteStart,
          },
        },
      );
    }
    if (sha256Hex(segBytes) !== row.segmentSha256) {
      throw new ElizaError("Stored segment digest does not match its bytes", {
        code: "MEMORY_SEGMENT_DIGEST_MISMATCH",
        context: {
          memoryId,
          generation: descriptor.generation,
          byteStart: row.byteStart,
        },
      });
    }
    const from = Math.max(window.start, row.byteStart) - row.byteStart;
    const to = Math.min(window.end, row.byteEnd) - row.byteStart;
    if (to > from) parts.push(segBytes.subarray(from, to));
  }

  const pageBytes = concatBytes(parts);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(pageBytes);
  const end = window.start + pageBytes.length;

  return {
    text,
    start: window.start,
    end,
    total: descriptor.totalBytes,
    sliceSha256: sha256Hex(pageBytes),
    sourceSha256: descriptor.totalSha256,
    revision: descriptor.revision,
    completeness:
      end >= descriptor.totalBytes ? "complete" : "partial-recoverable",
  };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export { buildSegmentationRevision };
