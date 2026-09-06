/**
 * Segmented-content store for the `memory_text_segments` table (#25140):
 * planning of immutable UTF-8 source segments plus a bounded parent
 * descriptor, transactional publication, generation retirement, and
 * authorized byte-window page reads that never materialize the parent content
 * or join embeddings. Consumed by BaseDrizzleAdapter; segmented parents carry
 * their descriptors in `metadata.segmentation[<fieldKey>]`, never the source
 * bytes. Not a second attachment/media byte store.
 */

import { createHash } from "node:crypto";
import {
  buildSegmentedContentMarker,
  type ComputedMemorySegment,
  clampPageWindow,
  ElizaError,
  encodeUtf8Strict,
  MEMORY_SEGMENTATION_THRESHOLD_BYTES,
  type MemorySegmentField,
  memorySegmentFieldKey,
  segmentMemoryContent,
  type UUID,
} from "@elizaos/core";
import { and, asc, eq, gt, lt, type SQL, sql } from "drizzle-orm";
import { memoryTable, memoryTextSegmentTable } from "../schema/index";
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

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readDescriptors(metadata: unknown): Map<string, StoredSegmentationDescriptor> {
  const out = new Map<string, StoredSegmentationDescriptor>();
  if (!metadata || typeof metadata !== "object") return out;
  const segmentation = (metadata as { segmentation?: unknown }).segmentation;
  if (!segmentation || typeof segmentation !== "object") return out;
  for (const [key, value] of Object.entries(segmentation as Record<string, unknown>)) {
    if (value && typeof value === "object" && (value as { v?: unknown }).v === 1) {
      out.set(key, value as StoredSegmentationDescriptor);
    }
  }
  return out;
}

export { readDescriptors as readSegmentationDescriptors };

/** Merges a segmentation descriptor into parent metadata (pure). */
export function mergeSegmentationMetadata(
  existingMetadata: unknown,
  descriptor: StoredSegmentationDescriptor
): Record<string, unknown> {
  const metadata =
    existingMetadata && typeof existingMetadata === "object"
      ? { ...(existingMetadata as Record<string, unknown>) }
      : {};
  const segmentation = {
    ...((metadata.segmentation as Record<string, unknown> | undefined) ?? {}),
  };
  segmentation[memorySegmentFieldKey(descriptor.field)] = descriptor;
  metadata.segmentation = segmentation;
  return metadata;
}

/**
 * Pure planning pass: computes the immutable segments and the bounded
 * descriptor for `text`, minting a fresh generation. The caller persists the
 * parent row (carrying the merged metadata) FIRST, then
 * `insertSegmentsInTransaction`, both inside one transaction — parent-first
 * satisfies the FK, and rollback leaves neither parent nor orphaned rows.
 */
export function planSegmentedField(params: {
  field: MemorySegmentField;
  text: string;
  segmentBytes?: number;
}): {
  segments: ComputedMemorySegment[];
  descriptor: StoredSegmentationDescriptor;
} {
  return segmentMemoryContent(params.text, params.field, {
    ...(params.segmentBytes ? { segmentBytes: params.segmentBytes } : {}),
  });
}

/** Inserts the planned generation's rows. Parent row must already exist. */
export async function insertSegmentsInTransaction(params: {
  tx: DrizzleDatabase;
  parentId: UUID;
  segments: ComputedMemorySegment[];
  generation: string;
}): Promise<void> {
  if (params.segments.length === 0) return;
  await params.tx.insert(memoryTextSegmentTable).values(
    params.segments.map((segment) => ({
      parentId: params.parentId,
      generation: params.generation,
      segmentIndex: segment.index,
      byteStart: segment.byteStart,
      byteEnd: segment.byteEnd,
      text: segment.text,
      segmentSha256: segment.sha256,
    }))
  );
}

/**
 * Deletes every segment generation of this parent that is no longer live in
 * the (already-updated) parent metadata. Run in the same transaction as the
 * replacement so retired generations never outlive their descriptor switch.
 */
export async function retireStaleGenerationsInTransaction(params: {
  tx: DrizzleDatabase;
  parentId: UUID;
  liveMetadata: unknown;
}): Promise<void> {
  const live = [...readDescriptors(params.liveMetadata).values()].map(
    (descriptor) => descriptor.generation
  );
  if (live.length === 0) {
    await params.tx
      .delete(memoryTextSegmentTable)
      .where(eq(memoryTextSegmentTable.parentId, params.parentId));
    return;
  }
  await params.tx
    .delete(memoryTextSegmentTable)
    .where(
      and(
        eq(memoryTextSegmentTable.parentId, params.parentId),
        sql`${memoryTextSegmentTable.generation} NOT IN ${live}`
      )
    );
}

const MEMORY_REINDEX_MAX_SOURCE_BYTES = 16 * 1024 * 1024;

/**
 * Converts exactly one authorized legacy inline field. The parent is locked
 * while its byte length is checked, and source bytes are fetched only after
 * both the caller's bound and the adapter's hard ceiling accept the work.
 */
export async function reindexMemoryContent(params: {
  db: DrizzleDatabase;
  memoryId: UUID;
  field: MemorySegmentField;
  maxSourceBytes: number;
  parentAuthorization: SQL;
}): Promise<{
  memoryId: UUID;
  field: MemorySegmentField;
  totalBytes: number;
  segmentCount: number;
  sourceSha256: string;
  revision: string;
}> {
  if (
    !Number.isSafeInteger(params.maxSourceBytes) ||
    params.maxSourceBytes <= MEMORY_SEGMENTATION_THRESHOLD_BYTES ||
    params.maxSourceBytes > MEMORY_REINDEX_MAX_SOURCE_BYTES
  ) {
    throw new ElizaError("Legacy content reindex bound is invalid", {
      code: "MEMORY_CONTENT_REINDEX_INVALID_BOUND",
      context: {
        maxSourceBytes: params.maxSourceBytes,
        hardMaxBytes: MEMORY_REINDEX_MAX_SOURCE_BYTES,
      },
    });
  }
  const authz = sql` AND (${params.parentAuthorization})`;
  return params.db.transaction(async (tx) => {
    const sizeExpression =
      params.field.kind === "content.text"
        ? sql`octet_length(COALESCE(content->>'text',''))`
        : sql`(SELECT CASE WHEN count(*) = 1 THEN max(octet_length(a.value->>'text')) END
              FROM jsonb_array_elements(COALESCE(content->'attachments','[]'::jsonb))
                   WITH ORDINALITY a(value, ordinal)
              WHERE a.value->>'id' = ${params.field.attachmentId})`;
    const locked = await tx.execute(sql`
      SELECT metadata, ${sizeExpression} AS field_bytes
      FROM memories WHERE id = ${params.memoryId}${authz} FOR UPDATE
    `);
    const parent = (
      locked.rows as Array<{ metadata: unknown; field_bytes: number | string | null }>
    )[0];
    if (!parent) {
      throw new ElizaError("Memory content reindex is not authorized", {
        code: "MEMORY_CONTENT_REINDEX_NOT_AUTHORIZED",
        context: { memoryId: params.memoryId },
      });
    }
    if (readDescriptors(parent.metadata).has(memorySegmentFieldKey(params.field))) {
      throw new ElizaError("Memory content field is already segmented", {
        code: "MEMORY_CONTENT_ALREADY_SEGMENTED",
        context: { memoryId: params.memoryId },
      });
    }
    if (parent.field_bytes === null) {
      throw new ElizaError("Attachment locator is missing or ambiguous", {
        code: "MEMORY_CONTENT_REINDEX_FIELD_NOT_FOUND",
        context: { memoryId: params.memoryId },
      });
    }
    const totalBytes = Number(parent.field_bytes);
    if (!Number.isSafeInteger(totalBytes)) {
      throw new ElizaError("Legacy content byte length is invalid", {
        code: "MEMORY_CONTENT_REINDEX_SOURCE_DRIFT",
        context: { memoryId: params.memoryId },
      });
    }
    if (totalBytes <= MEMORY_SEGMENTATION_THRESHOLD_BYTES) {
      throw new ElizaError("Inline content does not require reindex", {
        code: "MEMORY_CONTENT_REINDEX_NOT_REQUIRED",
        context: { memoryId: params.memoryId, totalBytes },
      });
    }
    if (totalBytes > params.maxSourceBytes) {
      throw new ElizaError("Legacy content exceeds the declared reindex bound", {
        code: "MEMORY_CONTENT_REINDEX_BOUND_EXCEEDED",
        context: { memoryId: params.memoryId, totalBytes, maxSourceBytes: params.maxSourceBytes },
      });
    }

    const sourceQuery =
      params.field.kind === "content.text"
        ? sql`SELECT content->>'text' AS source FROM memories WHERE id = ${params.memoryId}${authz}`
        : sql`SELECT a.value->>'text' AS source
              FROM memories, jsonb_array_elements(COALESCE(content->'attachments','[]'::jsonb)) a(value)
              WHERE id = ${params.memoryId}${authz}
                AND a.value->>'id' = ${params.field.attachmentId}`;
    const sourceRows = await tx.execute(sourceQuery);
    const source = (sourceRows.rows as Array<{ source: string }>)[0]?.source;
    if (typeof source !== "string" || encodeUtf8Strict(source).length !== totalBytes) {
      throw new ElizaError("Legacy source changed during reindex", {
        code: "MEMORY_CONTENT_REINDEX_SOURCE_DRIFT",
        context: { memoryId: params.memoryId },
      });
    }
    const planned = planSegmentedField({ field: params.field, text: source });
    const metadata = mergeSegmentationMetadata(parent.metadata, planned.descriptor);
    const marker = buildSegmentedContentMarker(planned.descriptor);

    if (params.field.kind === "content.text") {
      const updated = await tx
        .update(memoryTable)
        .set({
          content: sql`jsonb_set(content, '{text}', to_jsonb(${marker}::text), false)`,
          metadata,
        })
        .where(and(eq(memoryTable.id, params.memoryId), params.parentAuthorization))
        .returning();
      if (updated.length !== 1) {
        throw new ElizaError("Memory content reindex authorization changed", {
          code: "MEMORY_CONTENT_REINDEX_NOT_AUTHORIZED",
          context: { memoryId: params.memoryId },
        });
      }
    } else {
      const updated = await tx.execute(sql`
        UPDATE memories SET
          content = jsonb_set(content, ARRAY['attachments', located.ordinal::text, 'text'], to_jsonb(${marker}::text), false),
          metadata = ${JSON.stringify(metadata)}::jsonb
        FROM (
          SELECT a.ordinal - 1 AS ordinal
          FROM memories m, jsonb_array_elements(COALESCE(m.content->'attachments','[]'::jsonb))
               WITH ORDINALITY a(value, ordinal)
          WHERE m.id = ${params.memoryId} AND a.value->>'id' = ${params.field.attachmentId}
        ) located
        WHERE memories.id = ${params.memoryId}${authz}
        RETURNING memories.id
      `);
      if (updated.rows.length !== 1) {
        throw new ElizaError("Memory content reindex authorization changed", {
          code: "MEMORY_CONTENT_REINDEX_NOT_AUTHORIZED",
          context: { memoryId: params.memoryId },
        });
      }
    }
    await insertSegmentsInTransaction({
      tx,
      parentId: params.memoryId,
      segments: planned.segments,
      generation: planned.descriptor.generation,
    });
    return {
      memoryId: params.memoryId,
      field: params.field,
      totalBytes,
      segmentCount: planned.descriptor.segmentCount,
      sourceSha256: planned.descriptor.totalSha256,
      revision: planned.descriptor.revision,
    };
  });
}

/**
 * Authorized byte-window page read over a segmented field. Throws typed
 * ElizaErrors: MEMORY_CONTENT_REINDEX_REQUIRED for legacy unsegmented rows
 * whose inline field exceeds the hard page ceiling (a single bounded read can
 * never serve them), MEMORY_CONTENT_STALE_REVISION for continuation
 * mismatches, and MEMORY_SEGMENT_DESCRIPTOR_DRIFT / DIGEST_MISMATCH for
 * storage corruption. Returns null when the field has no descriptor and the
 * inline value fits a bounded page — callers fall back to the ordinary
 * small-row read.
 */
export async function readMemoryContentPage(params: {
  db: DrizzleDatabase;
  memoryId: UUID;
  field: MemorySegmentField;
  byteStart: number;
  byteLimit?: number;
  expectedRevision?: string;
  /**
   * Raw authorization predicate over the memories table (aliased SQL, no
   * table prefix). When supplied it is ANDed into EVERY parent-row read inside
   * the repeatable-read snapshot, so the authorization decision and the page
   * bytes come from one consistent read — access revoked concurrently cannot
   * slip a page through between the two.
   */
  parentAuthorization?: SQL;
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
  const authz = params.parentAuthorization ? sql` AND (${params.parentAuthorization})` : sql``;

  // Snapshot consistency (#25140 review): the descriptor (parent row) and the
  // segment rows must be read under one repeatable-read snapshot so a
  // concurrent replacement cannot switch the generation between the two reads
  // (plain READ COMMITTED gives each statement its own snapshot).
  return await db.transaction(
    async (tx) => {
      const parentRows = await tx.execute(sql`
    SELECT id, metadata, content FROM memories WHERE id = ${memoryId}${authz} LIMIT 1
  `);
      const parentRow = (
        parentRows.rows as Array<{ id: UUID; metadata: unknown; content: unknown }>
      )[0];
      if (!parentRow) return null;

      const descriptor = readDescriptors(parentRow.metadata).get(memorySegmentFieldKey(field));

      if (descriptor) {
        // Marker forgery fence: the inline field must carry EXACTLY the canonical
        // marker for this descriptor. A user-crafted string with the marker
        // prefix but no matching descriptor never reaches here (no descriptor),
        // and a stored state where the marker and descriptor disagree is
        // corruption, not a pageable field.
        const content =
          parentRow.content && typeof parentRow.content === "object"
            ? (parentRow.content as { text?: unknown; attachments?: unknown })
            : undefined;
        let inlineText: unknown;
        if (field.kind === "content.text") {
          inlineText = content?.text;
        } else {
          const attachments = Array.isArray(content?.attachments) ? content.attachments : [];
          const match = attachments.find(
            (a) => a && typeof a === "object" && (a as { id?: unknown }).id === field.attachmentId
          );
          inlineText =
            match && typeof match === "object" ? (match as { text?: unknown }).text : undefined;
        }
        const expectedMarker = buildSegmentedContentMarker(descriptor);
        if (inlineText !== expectedMarker) {
          throw new ElizaError("Segmented field inline marker does not match its descriptor", {
            code: "MEMORY_SEGMENT_MARKER_MISMATCH",
            context: { memoryId, fieldKey: memorySegmentFieldKey(field) },
          });
        }
      }

      if (!descriptor) {
        const attachmentFilter =
          field.kind === "attachment.text" ? sql`a->>'id' = ${field.attachmentId}` : sql`false`;
        const inlineBytes = await tx.execute(sql`
      SELECT octet_length(COALESCE(content->>'text','')) AS text_bytes,
             (
               SELECT COALESCE(sum(octet_length(a->>'text')), 0)
               FROM jsonb_array_elements(COALESCE(content->'attachments','[]'::jsonb)) a
               WHERE ${attachmentFilter}
             ) AS attachment_bytes
      FROM memories WHERE id = ${memoryId}${authz}
    `);
        const row = (
          inlineBytes.rows as Array<{
            text_bytes: number;
            attachment_bytes: number;
          }>
        )[0];
        const fieldBytes =
          field.kind === "attachment.text" ? row?.attachment_bytes : row?.text_bytes;
        // Fail closed at the SEGMENTATION THRESHOLD, not the page ceiling: any
        // legacy row a fresh write would have segmented is exactly the row a
        // single bounded page cannot be trusted to serve inline.
        if (fieldBytes !== undefined && fieldBytes > MEMORY_SEGMENTATION_THRESHOLD_BYTES) {
          throw new ElizaError(
            "Legacy large unsegmented content requires an authorized reindex before paged reads",
            {
              code: "MEMORY_CONTENT_REINDEX_REQUIRED",
              context: { memoryId, fieldKind: field.kind, fieldBytes },
            }
          );
        }
        return null;
      }

      if (params.byteStart > 0 && !params.expectedRevision) {
        throw new ElizaError("Stored-content continuation requires expectedRevision.", {
          code: "MEMORY_CONTENT_EXPECTED_REVISION_REQUIRED",
          context: { memoryId },
        });
      }
      if (params.expectedRevision && params.expectedRevision !== descriptor.revision) {
        throw new ElizaError("The stored content changed before this page could be read.", {
          code: "MEMORY_CONTENT_STALE_REVISION",
          context: { currentRevision: descriptor.revision },
        });
      }

      const window = clampPageWindow(descriptor.totalBytes, params.byteStart, params.byteLimit);

      // Empty-terminal page: an offset exactly at end-of-source is a complete,
      // empty page — not a drift error.
      if (window.start === descriptor.totalBytes) {
        return {
          text: "",
          start: window.start,
          end: window.start,
          total: descriptor.totalBytes,
          sliceSha256: sha256Hex(new Uint8Array(0)),
          sourceSha256: descriptor.totalSha256,
          revision: descriptor.revision,
          completeness: "complete" as const,
        };
      }

      const segmentRows = await tx
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
            lt(memoryTextSegmentTable.byteStart, window.end),
            gt(memoryTextSegmentTable.byteEnd, window.start)
          )
        )
        .orderBy(asc(memoryTextSegmentTable.byteStart));

      if (segmentRows.length === 0) {
        throw new ElizaError("Segmented content descriptor does not match its segment rows", {
          code: "MEMORY_SEGMENT_DESCRIPTOR_DRIFT",
          context: { memoryId, generation: descriptor.generation },
        });
      }

      // Assemble the intersecting segments' full bytes (bounded: the page window
      // plus at most one segment on each side), verify each segment, then slice
      // the window with the end snapped back to a UTF-8 code point boundary so a
      // page never splits a code point and the returned `end` is a valid
      // continuation offset.
      const segmentBytes: Uint8Array[] = [];
      const base = segmentRows[0].byteStart;
      for (const row of segmentRows) {
        const segBytes = encodeUtf8Strict(row.text);
        if (segBytes.length !== row.byteEnd - row.byteStart) {
          throw new ElizaError("Stored segment byte length does not match its range", {
            code: "MEMORY_SEGMENT_DESCRIPTOR_DRIFT",
            context: {
              memoryId,
              generation: descriptor.generation,
              byteStart: row.byteStart,
            },
          });
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
        segmentBytes.push(segBytes);
      }
      // Coverage proof: the intersecting rows must form one contiguous run from
      // the first segment at/before `window.start` through the last segment at/before
      // `window.end`. A deleted middle row would otherwise be silently concatenated,
      // collapsing the gap and mislabeling the returned range.
      let expectedByteStart = base;
      for (const row of segmentRows) {
        if (row.byteStart !== expectedByteStart) {
          throw new ElizaError("Stored segment rows are not contiguous over the requested window", {
            code: "MEMORY_SEGMENT_DESCRIPTOR_DRIFT",
            context: {
              memoryId,
              generation: descriptor.generation,
              expectedByteStart,
              actualByteStart: row.byteStart,
            },
          });
        }
        expectedByteStart = row.byteEnd;
      }
      if (expectedByteStart < Math.min(window.end, descriptor.totalBytes)) {
        throw new ElizaError("Stored segment rows do not cover the requested window", {
          code: "MEMORY_SEGMENT_DESCRIPTOR_DRIFT",
          context: {
            memoryId,
            generation: descriptor.generation,
            coveredThrough: expectedByteStart,
            windowEnd: window.end,
          },
        });
      }
      const covered = concatBytes(segmentBytes);
      let from = window.start - base;
      let to = Math.min(window.end - base, covered.length);
      // Snap the end backward off any partial trailing code point.
      while (to > from && (covered[to] & 0xc0) === 0x80) {
        to -= 1;
      }
      // A caller offset that starts mid-code-point is invalid.
      if (from > 0 && (covered[from] & 0xc0) === 0x80) {
        throw new ElizaError("Page byte offset splits a UTF-8 code point", {
          code: "MEMORY_PAGE_INVALID_OFFSET",
          context: { memoryId, byteStart: window.start },
        });
      }
      const pageBytes = covered.subarray(from, to);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(pageBytes);
      const end = base + to;
      from = 0;

      return {
        text,
        start: window.start,
        end,
        total: descriptor.totalBytes,
        sliceSha256: sha256Hex(pageBytes),
        sourceSha256: descriptor.totalSha256,
        revision: descriptor.revision,
        completeness: end >= descriptor.totalBytes ? "complete" : "partial-recoverable",
      };
    },
    { isolationLevel: "repeatable read" }
  );
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
