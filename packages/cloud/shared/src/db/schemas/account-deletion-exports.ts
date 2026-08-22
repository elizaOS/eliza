/** Defines encrypted, expiring export receipts for the deletion recovery window. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { bigint, check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { accountDeletionRequests } from "./account-deletion-requests";

export type AccountDeletionExportStatus =
  | "pending"
  | "building"
  | "ready"
  | "expired"
  | "deleted"
  | "failed";

export const accountDeletionExports = pgTable(
  "account_deletion_exports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    request_id: uuid("request_id")
      .notNull()
      .references(() => accountDeletionRequests.id, { onDelete: "cascade" }),
    status: text("status").$type<AccountDeletionExportStatus>().notNull().default("pending"),
    content_digest: text("content_digest"),
    object_receipt_digest: text("object_receipt_digest"),
    byte_count: bigint("byte_count", { mode: "number" }),
    ready_at: timestamp("ready_at"),
    expires_at: timestamp("expires_at").notNull(),
    deleted_at: timestamp("deleted_at"),
    last_error_code: text("last_error_code"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    request_unique: unique("account_deletion_exports_request_unique").on(table.request_id),
    status_check: check(
      "account_deletion_exports_status_check",
      sql`${table.status} IN ('pending', 'building', 'ready', 'expired', 'deleted', 'failed')`,
    ),
  }),
);

export type AccountDeletionExport = InferSelectModel<typeof accountDeletionExports>;
export type NewAccountDeletionExport = InferInsertModel<typeof accountDeletionExports>;
