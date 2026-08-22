/** Defines generation-fenced, non-identifying receipts for deletion saga phases. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { accountDeletionRequests } from "./account-deletion-requests";

export const accountDeletionPhaseReceipts = pgTable(
  "account_deletion_phase_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    request_id: uuid("request_id")
      .notNull()
      .references(() => accountDeletionRequests.id, { onDelete: "cascade" }),
    phase: text("phase").notNull(),
    phase_order: integer("phase_order").notNull(),
    status: text("status").notNull().default("pending"),
    lease_generation: bigint("lease_generation", { mode: "number" }).notNull().default(0),
    lease_owner_digest: text("lease_owner_digest"),
    lease_expires_at: timestamp("lease_expires_at"),
    idempotency_key_digest: text("idempotency_key_digest").notNull(),
    provider_operation_digest: text("provider_operation_digest"),
    provider_receipt_digest: text("provider_receipt_digest"),
    attempt_count: integer("attempt_count").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(12),
    retry_class: text("retry_class"),
    next_attempt_at: timestamp("next_attempt_at"),
    before_provider_call_at: timestamp("before_provider_call_at"),
    provider_acknowledged_at: timestamp("provider_acknowledged_at"),
    reconciled_at: timestamp("reconciled_at"),
    completed_at: timestamp("completed_at"),
    last_error_code: text("last_error_code"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    request_phase_unique: unique("account_deletion_phase_receipts_request_phase_unique").on(
      table.request_id,
      table.phase,
    ),
    work_idx: index("account_deletion_phase_receipts_work_idx").on(
      table.status,
      table.next_attempt_at,
    ),
    status_check: check(
      "account_deletion_phase_receipts_status_check",
      sql`${table.status} IN ('pending', 'leased', 'calling', 'reconciling', 'retry', 'completed', 'canceled', 'action_required')`,
    ),
    attempt_check: check(
      "account_deletion_phase_receipts_attempt_check",
      sql`${table.phase_order} >= 0 AND ${table.attempt_count} >= 0 AND ${table.max_attempts} > 0 AND ${table.lease_generation} >= 0`,
    ),
  }),
);

export type AccountDeletionPhaseReceipt = InferSelectModel<typeof accountDeletionPhaseReceipts>;
export type NewAccountDeletionPhaseReceipt = InferInsertModel<typeof accountDeletionPhaseReceipts>;
