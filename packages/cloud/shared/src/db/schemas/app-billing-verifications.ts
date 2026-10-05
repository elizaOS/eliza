/** Records immutable merchant capability and catalog observations without changing published billing terms. */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { BillingProviderPlan } from "../../lib/services/generic-billing-provider-types";
import { appBillingPlanRevisions, billingMerchants } from "./app-billing";

export interface AppBillingMerchantVerification {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  cardPaymentsActive: boolean;
  disabledReason: string | null;
  requirementsDue: string[];
}
const observationColumns = () => ({
  id: uuid("id").defaultRandom().primaryKey(),
  merchant_id: uuid("merchant_id").notNull(),
  livemode: boolean("livemode").notNull(),
  provider_account_id: text("provider_account_id").notNull(),
  object_digest: text("object_digest").notNull(),
  input_digest: text("input_digest").notNull(),
  api_version: text("api_version").notNull(),
  observed_at: timestamp("observed_at", { withTimezone: true }).notNull(),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const appBillingMerchantVerifications = pgTable(
  "app_billing_merchant_verifications",
  {
    ...observationColumns(),
    value: jsonb("value").$type<AppBillingMerchantVerification>().notNull(),
  },
  (t) => ({
    merchant: foreignKey({
      columns: [t.merchant_id, t.livemode],
      foreignColumns: [billingMerchants.id, billingMerchants.livemode],
      name: "app_merchant_verifications_merchant_fk",
    }).onDelete("restrict"),
    recent: index("app_merchant_verifications_recent_idx").on(t.merchant_id, t.created_at),
    proof: check(
      "app_merchant_verifications_proof_check",
      sql`${t.provider_account_id} ~ '^acct_[A-Za-z0-9]+$' AND ${t.object_digest} ~ '^[0-9a-f]{64}$' AND ${t.input_digest} ~ '^[0-9a-f]{64}$' AND ${t.api_version} = '2024-11-20.acacia'`,
    ),
  }),
);
export const appBillingCatalogVerifications = pgTable(
  "app_billing_catalog_verifications",
  {
    ...observationColumns(),
    plan_revision_id: uuid("plan_revision_id")
      .notNull()
      .references(() => appBillingPlanRevisions.id, { onDelete: "restrict" }),
    value: jsonb("value").$type<BillingProviderPlan>().notNull(),
  },
  (t) => ({
    merchant: foreignKey({
      columns: [t.merchant_id, t.livemode],
      foreignColumns: [billingMerchants.id, billingMerchants.livemode],
      name: "app_catalog_verifications_merchant_fk",
    }).onDelete("restrict"),
    recent: index("app_catalog_verifications_recent_idx").on(t.plan_revision_id, t.created_at),
    proof: check(
      "app_catalog_verifications_proof_check",
      sql`${t.provider_account_id} ~ '^acct_[A-Za-z0-9]+$' AND ${t.object_digest} ~ '^[0-9a-f]{64}$' AND ${t.input_digest} ~ '^[0-9a-f]{64}$' AND ${t.api_version} = '2024-11-20.acacia'`,
    ),
  }),
);
