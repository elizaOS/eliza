/** Retains one immutable customer-wide closure identity; this intent grants no provider completion or physical erasure. */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { appBillingCustomers } from "./app-billing";
export const appBillingCustomerClosures = pgTable(
  "app_billing_customer_closures",
  {
    customer_binding_id: uuid("customer_binding_id")
      .primaryKey()
      .references(() => appBillingCustomers.id, { onDelete: "restrict" }),
    billing_account_id: uuid("billing_account_id").notNull(),
    app_id: uuid("app_id").notNull(),
    merchant_id: uuid("merchant_id").notNull(),
    provider_account_key: text("provider_account_key").notNull(),
    stripe_account_id: text("stripe_account_id").notNull(),
    livemode: boolean("livemode").notNull(),
    stripe_customer_id: text("stripe_customer_id").notNull(),
    initiating_request_id: uuid("initiating_request_id").notNull(),
    request_digest: text("request_digest").notNull(),
    lifecycle_revision: bigint("lifecycle_revision", { mode: "number" }).notNull(),
    phase_receipt_id: uuid("phase_receipt_id").notNull(),
    phase_generation: bigint("phase_generation", { mode: "number" }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    account_merchant: uniqueIndex("app_billing_customer_closures_account_merchant_idx").on(
      t.billing_account_id,
      t.merchant_id,
    ),
    provider_identity: uniqueIndex("app_billing_customer_closures_provider_idx").on(
      t.stripe_account_id,
      t.livemode,
      t.stripe_customer_id,
    ),
    shape: check(
      "app_billing_customer_closures_shape",
      sql`${t.request_digest} ~ '^[0-9a-f]{64}$' AND ${t.lifecycle_revision}>0 AND ${t.phase_generation}>0 AND ${t.stripe_account_id} ~ '^acct_[A-Za-z0-9]+$' AND ${t.stripe_customer_id} ~ '^cus_[A-Za-z0-9]+$'`,
    ),
  }),
);
