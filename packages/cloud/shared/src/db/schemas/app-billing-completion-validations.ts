/** Retains database-derived billing validation and its atomic phase completion linkage after live deletion receipts are erased. It carries no provider execution authority. */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const pgXid8 = customType<{ data: string }>({ dataType: () => "xid8" });

export const appBillingCompletionValidations = pgTable(
  "app_billing_completion_validations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    request_id: uuid("request_id").notNull(),
    request_digest: text("request_digest").notNull(),
    lifecycle_revision: bigint("lifecycle_revision", { mode: "number" }).notNull(),
    phase_receipt_id: uuid("phase_receipt_id").notNull(),
    phase_generation: bigint("phase_generation", { mode: "number" }).notNull(),
    provider_receipt_digest: text("provider_receipt_digest").notNull(),
    validation_xid: pgXid8("validation_xid").notNull(),
    inventory_digest: text("inventory_digest").notNull(),
    validated_at: timestamp("validated_at", { withTimezone: true }).notNull(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => ({
    phaseTransaction: uniqueIndex("app_billing_completion_validations_phase_xid_idx").on(
      t.phase_receipt_id,
      t.validation_xid,
    ),
    completedTransaction: index("app_billing_completion_validations_completed_xid_idx")
      .on(t.validation_xid)
      .where(sql`${t.completed_at} IS NOT NULL`),
    digestShape: check(
      "app_billing_completion_validations_digest_check",
      sql`${t.request_digest} ~ '^[0-9a-f]{64}$' AND ${t.provider_receipt_digest} ~ '^[0-9a-f]{64}$' AND ${t.inventory_digest} ~ '^[0-9a-f]{64}$'`,
    ),
  }),
);
