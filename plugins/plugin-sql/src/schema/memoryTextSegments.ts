/**
 * Immutable UTF-8 source segments for bounded native paging of large stored
 * MESSAGE text and extracted ATTACHMENT text (#25140). A segmented parent
 * memory keeps only a bounded descriptor in its metadata; the source bytes
 * live exclusively here as non-overlapping rows keyed by the immutable
 * generation. Rows cascade with their parent and are never returned by
 * generic memory list/search paths. This stores extracted text only — it is
 * not a second attachment/media byte store.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { memoryTable } from "./memory";

export const memoryTextSegmentTable = pgTable(
  "memory_text_segments",
  {
    parentId: uuid("parent_id")
      .notNull()
      .references(() => memoryTable.id, { onDelete: "cascade" }),
    /** Immutable generation identity; a replacement mints a new one. */
    generation: uuid("generation").notNull(),
    segmentIndex: integer("segment_index").notNull(),
    byteStart: bigint("byte_start", { mode: "number" }).notNull(),
    /** Exclusive byte end; contiguity is validated at publication time. */
    byteEnd: bigint("byte_end", { mode: "number" }).notNull(),
    text: text("text").notNull(),
    segmentSha256: text("segment_sha256").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.parentId, table.generation, table.segmentIndex],
    }),
    index("idx_memory_text_segments_range").on(table.parentId, table.generation, table.byteStart),
    check(
      "memory_text_segment_range_check",
      sql`${table.byteStart} >= 0 AND ${table.byteEnd} > ${table.byteStart}`
    ),
    check("memory_text_segment_digest_check", sql`char_length(${table.segmentSha256}) = 64`),
  ]
);
