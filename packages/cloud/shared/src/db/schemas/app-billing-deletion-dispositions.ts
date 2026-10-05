/** Retains canonical deletion decisions without claiming provider cleanup or granting physical erasure. A closing scope can never reopen. */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { appBillingScopes } from "./app-billing";

export const appBillingDeletionDispositions = pgTable(
  "app_billing_deletion_dispositions",
  {
    request_id: uuid("request_id").notNull(),
    scope_id: uuid("scope_id")
      .notNull()
      .references(() => appBillingScopes.id, { onDelete: "restrict" }),
    request_digest: text("request_digest").notNull(),
    lifecycle_revision: bigint("lifecycle_revision", { mode: "number" }).notNull(),
    phase_receipt_id: uuid("phase_receipt_id").notNull(),
    phase_generation: bigint("phase_generation", { mode: "number" }).notNull(),
    merchant_id: uuid("merchant_id").notNull(),
    provider_account_key: text("provider_account_key").notNull(),
    livemode: boolean("livemode").notNull(),
    disposition: text("disposition").$type<"retain_shared" | "close">().notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    key: primaryKey({ columns: [t.request_id, t.scope_id] }),
    shape: check(
      "app_billing_deletion_dispositions_shape",
      sql`${t.request_digest} ~ '^[0-9a-f]{64}$' AND ${t.lifecycle_revision}>0 AND ${t.phase_generation}>0 AND ${t.disposition} IN ('retain_shared','close')`,
    ),
  }),
);
