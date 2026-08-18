/**
 * Server-bound promotion epochs for Shared→Dedicated memory transfer
 * (round 3, #21090 architecture review). One row per (organization, user,
 * agent) transfer scope. The epoch is the write fence: while `state` is
 * `fenced`, the shared-runtime memory commit path refuses writes for the
 * scope, so a sealed export cannot race a writer. `promoted` is terminal for
 * an epoch number — finalizing twice, or importing a stale epoch's seal,
 * fails closed on this state machine rather than on caller discipline.
 */
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { organizations } from "./organizations";
import { users } from "./users";

export const sharedTransferEpochs = pgTable(
  "shared_transfer_epochs",
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
    state: text("state").notNull(), // open | fenced | promoted | aborted
    seal_digest: text("seal_digest"),
    fenced_at: timestamp("fenced_at"),
    resolved_at: timestamp("resolved_at"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    scopeEpochUnique: uniqueIndex("uq_shared_transfer_epochs_scope_epoch").on(
      table.organization_id,
      table.user_id,
      table.agent_id,
      table.epoch,
    ),
    scopeStateIdx: index("idx_shared_transfer_epochs_scope_state").on(
      table.organization_id,
      table.user_id,
      table.agent_id,
      table.state,
    ),
  }),
);

export type SharedTransferEpochRow = InferSelectModel<typeof sharedTransferEpochs>;
export type SharedTransferEpochInsert = InferInsertModel<typeof sharedTransferEpochs>;
