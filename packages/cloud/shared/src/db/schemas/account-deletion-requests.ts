/**
 * Defines durable deletion receipts without user or organization foreign keys.
 * The compliance record must survive deletion of the account it describes.
 */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export type AccountDeletionRequestStatus =
  | "requested"
  | "reserved"
  | "recovery"
  | "scheduled"
  | "processing"
  | "completed"
  | "canceled"
  | "action_required";

export const accountDeletionRequests = pgTable(
  "account_deletion_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    user_id: uuid("user_id"),
    organization_id: uuid("organization_id"),
    steward_user_id: text("steward_user_id"),
    operation_kind: text("operation_kind")
      .notNull()
      .default("personal_account_deletion"),
    status: text("status")
      .$type<AccountDeletionRequestStatus>()
      .notNull()
      .default("reserved"),
    lifecycle_revision: bigint("lifecycle_revision", { mode: "number" })
      .notNull()
      .default(1),
    lease_generation: bigint("lease_generation", { mode: "number" })
      .notNull()
      .default(0),
    lease_expires_at: timestamp("lease_expires_at"),
    status_token_hash: text("status_token_hash"),
    status_token_expires_at: timestamp("status_token_expires_at"),
    recovery_token_hash: text("recovery_token_hash"),
    recovery_token_expires_at: timestamp("recovery_token_expires_at"),
    request_digest: text("request_digest"),
    restore_auto_top_up_enabled: boolean("restore_auto_top_up_enabled"),
    restore_pay_as_you_go_from_earnings: boolean(
      "restore_pay_as_you_go_from_earnings",
    ),
    requested_at: timestamp("requested_at").notNull().defaultNow(),
    recovery_expires_at: timestamp("recovery_expires_at"),
    execute_after: timestamp("execute_after").notNull(),
    identity_deactivated_at: timestamp("identity_deactivated_at"),
    processing_started_at: timestamp("processing_started_at"),
    irreversible_at: timestamp("irreversible_at"),
    canceled_at: timestamp("canceled_at"),
    completed_at: timestamp("completed_at"),
    completion_receipt_digest: text("completion_receipt_digest"),
    last_error_code: text("last_error_code"),
    failure_class: text("failure_class"),
    next_reconcile_at: timestamp("next_reconcile_at"),
    attempts: integer("attempts").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(5),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    user_idx: index("account_deletion_requests_user_idx").on(table.user_id),
    due_idx: index("account_deletion_requests_due_idx").on(
      table.status,
      table.execute_after,
    ),
    status_token_idx: uniqueIndex("account_deletion_requests_status_token_idx")
      .on(table.status_token_hash)
      .where(sql`${table.status_token_hash} IS NOT NULL`),
    recovery_token_idx: uniqueIndex(
      "account_deletion_requests_recovery_token_idx",
    )
      .on(table.recovery_token_hash)
      .where(sql`${table.recovery_token_hash} IS NOT NULL`),
    one_open_request_per_user: uniqueIndex(
      "account_deletion_requests_one_open_user_idx",
    )
      .on(table.user_id)
      .where(
        sql`${table.completed_at} IS NULL AND ${table.user_id} IS NOT NULL`,
      ),
    status_check: check(
      "account_deletion_requests_status_check",
      sql`${table.status} IN ('requested', 'reserved', 'recovery', 'scheduled', 'processing', 'completed', 'canceled', 'action_required')`,
    ),
    operation_kind_check: check(
      "account_deletion_requests_operation_kind_check",
      sql`${table.operation_kind} = 'personal_account_deletion'`,
    ),
    attempts_check: check(
      "account_deletion_requests_attempts_check",
      sql`${table.attempts} >= 0 AND ${table.max_attempts} > 0 AND ${table.lifecycle_revision} > 0 AND ${table.lease_generation} >= 0`,
    ),
  }),
);

export type AccountDeletionRequest = InferSelectModel<
  typeof accountDeletionRequests
>;
export type NewAccountDeletionRequest = InferInsertModel<
  typeof accountDeletionRequests
>;
