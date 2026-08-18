/**
 * Staging rows for the sealed Shared→Dedicated memory transfer (round 3,
 * #21090 review). Batches land here keyed by their whole-export seal digest
 * and stay invisible to every runtime read path; `finalizeSealedImport`
 * republishes the complete verified set into `memories`/`embeddings` in one
 * transaction and drains the staged rows. Rows are bounded by the importer:
 * per-seal counts must match the signed seal, and seals older than the
 * staging TTL are swept on the next stage/finalize call — an abandoned
 * transfer can never accrete storage indefinitely.
 */
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const memoryImportStagingTable = pgTable(
  "memory_import_staging",
  {
    sealDigest: text("seal_digest").notNull(),
    rowId: uuid("row_id").notNull(),
    rowIndex: integer("row_index").notNull(),
    payload: jsonb("payload").notNull(),
    stagedAt: timestamp("staged_at", { withTimezone: true }).default(sql`now()`).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sealDigest, table.rowId] }),
    index("idx_memory_import_staging_staged_at").on(table.stagedAt),
  ]
);
