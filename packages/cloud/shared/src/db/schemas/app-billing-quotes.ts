/** Persists the exact app subscription update shown to a purchaser until one command consumes it. */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { BillingProviderUpdatePreview } from "../../lib/services/generic-billing-provider-types";
import { appBillingPlanRevisions, appBillingScopes, billingMerchants } from "./app-billing";
import { billingIdentitySubjects } from "./billing-identities";
import { billingSubscriptions } from "./billing-subscriptions";
import { billingSubscriptionCommands } from "./subscription-billing-operations";

export const appBillingQuotes = pgTable(
  "app_billing_quotes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id").notNull(),
    billing_scope_id: uuid("billing_scope_id").notNull(),
    actor_user_id: uuid("actor_user_id")
      .notNull()
      .references(() => billingIdentitySubjects.id, { onDelete: "restrict" }),
    subscription_id: uuid("subscription_id")
      .notNull()
      .references(() => billingSubscriptions.id, { onDelete: "restrict" }),
    subscription_revision: bigint("subscription_revision", { mode: "number" }).notNull(),
    plan_revision_id: uuid("plan_revision_id")
      .notNull()
      .references(() => appBillingPlanRevisions.id, { onDelete: "restrict" }),
    quantity: integer("quantity").notNull(),
    merchant_id: uuid("merchant_id").notNull(),
    livemode: boolean("livemode").notNull(),
    provider_preview: jsonb("provider_preview").$type<BillingProviderUpdatePreview>().notNull(),
    digest: text("digest").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    consumed_by_command_id: uuid("consumed_by_command_id").references(
      () => billingSubscriptionCommands.id,
      { onDelete: "restrict" },
    ),
    consumed_at: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => ({
    scope: foreignKey({
      columns: [t.billing_scope_id, t.app_id, t.livemode],
      foreignColumns: [appBillingScopes.id, appBillingScopes.app_id, appBillingScopes.livemode],
      name: "app_billing_quotes_scope_fk",
    }).onDelete("restrict"),
    merchant: foreignKey({
      columns: [t.merchant_id, t.livemode],
      foreignColumns: [billingMerchants.id, billingMerchants.livemode],
      name: "app_billing_quotes_merchant_fk",
    }).onDelete("restrict"),
    scope_created: index("app_billing_quotes_scope_created_idx").on(
      t.billing_scope_id,
      t.created_at,
    ),
    shape: check(
      "app_billing_quotes_shape_check",
      sql`${t.subscription_revision} > 0 AND ${t.quantity} > 0 AND ${t.digest} ~ '^[0-9a-f]{64}$' AND ${t.expires_at} > ${t.created_at} AND (${t.consumed_by_command_id} IS NULL) = (${t.consumed_at} IS NULL)`,
    ),
  }),
);
