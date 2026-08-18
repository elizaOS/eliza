/**
 * Persisted destination-bound transfer record (round 4, #21631 close
 * directive). One row per promotion attempt: it binds the epoch to ONE
 * destination host at creation, accumulates per-batch and finalize replay
 * receipts, and carries the delivery state machine
 * `created → delivering → finalized → promoted | aborted`. A resumed
 * coordinator run must present the SAME destination host (destination-bound)
 * and uses the acked-batch receipts to skip work it has already proven —
 * replays are auditable from this row alone.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export const sharedTransferRecords = pgTable(
  "shared_transfer_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agent_id: uuid("agent_id").notNull(),
    epoch: integer("epoch").notNull(),
    destination_host: text("destination_host").notNull(),
    seal_digest: text("seal_digest"),
    batch_count: integer("batch_count"),
    state: text("state").notNull(), // created | delivering | finalized | promoted | aborted
    /** Array of {kind:"stage",batch_index,total_staged,at} and {kind:"finalize",published,skipped_existing,at}. */
    receipts: jsonb("receipts").$type<Array<Record<string, unknown>>>().notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    scopeEpochUnique: uniqueIndex("uq_shared_transfer_records_scope_epoch").on(
      table.organization_id,
      table.user_id,
      table.agent_id,
      table.epoch,
    ),
    scopeStateIdx: index("idx_shared_transfer_records_scope_state").on(
      table.organization_id,
      table.user_id,
      table.agent_id,
      table.state,
    ),
  }),
);

export type SharedTransferRecordRow = InferSelectModel<typeof sharedTransferRecords>;
export type SharedTransferRecordInsert = InferInsertModel<typeof sharedTransferRecords>;
