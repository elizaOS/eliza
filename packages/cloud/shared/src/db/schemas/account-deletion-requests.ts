// Durable account-deletion receipts intentionally have no user/org foreign keys:
// the compliance record must survive deletion of the account it describes.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const accountDeletionRequests = pgTable(
  "account_deletion_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    user_id: uuid("user_id"),
    organization_id: uuid("organization_id"),
    steward_user_id: text("steward_user_id"),
    status: text("status").notNull().default("requested"),
    requested_at: timestamp("requested_at").notNull().defaultNow(),
    execute_after: timestamp("execute_after").notNull(),
    identity_deactivated_at: timestamp("identity_deactivated_at"),
    processing_started_at: timestamp("processing_started_at"),
    completed_at: timestamp("completed_at"),
    last_error_code: text("last_error_code"),
    attempts: integer("attempts").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(5),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    user_idx: index("account_deletion_requests_user_idx").on(table.user_id),
    due_idx: index("account_deletion_requests_due_idx").on(table.status, table.execute_after),
    one_open_request_per_user: uniqueIndex("account_deletion_requests_one_open_user_idx")
      .on(table.user_id)
      .where(sql`${table.completed_at} IS NULL AND ${table.user_id} IS NOT NULL`),
    status_check: check(
      "account_deletion_requests_status_check",
      sql`${table.status} IN ('requested', 'scheduled', 'processing', 'completed', 'action_required')`,
    ),
    attempts_check: check(
      "account_deletion_requests_attempts_check",
      sql`${table.attempts} >= 0 AND ${table.max_attempts} > 0`,
    ),
  }),
);

export type AccountDeletionRequest = InferSelectModel<typeof accountDeletionRequests>;
export type NewAccountDeletionRequest = InferInsertModel<typeof accountDeletionRequests>;
