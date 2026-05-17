import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Organizations table schema (core).
 *
 * Represents a billing organization that can contain multiple users.
 *
 * NOTE: `settings` is kept here because it's deeply used across many API routes
 * and container management. The organization_config table serves as a read-optimized
 * projection for less-frequently-accessed configuration.
 *
 * Billing details → organization_billing table
 * Extended config → organization_config table
 */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    credit_balance: numeric("credit_balance", { precision: 12, scale: 6 })
      .notNull()
      .default("100.000000"),

    // Settings (kept for backward compatibility with container management)
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}),

    // Billing (kept for backward compatibility with billing/payment routes)
    stripe_customer_id: text("stripe_customer_id"),
    billing_email: text("billing_email"),
    stripe_payment_method_id: text("stripe_payment_method_id"),
    stripe_default_payment_method: text("stripe_default_payment_method"),
    auto_top_up_enabled: boolean("auto_top_up_enabled").default(false),
    auto_top_up_threshold: numeric("auto_top_up_threshold", {
      precision: 10,
      scale: 2,
    }),
    auto_top_up_amount: numeric("auto_top_up_amount", {
      precision: 10,
      scale: 2,
    }),

    // When true, container daily-billing debits the org owner's
    // redeemable_earnings before falling through to credit_balance.
    // When false, hosting is paid purely from credits (legacy behavior),
    // leaving earnings untouched for token cashout.
    pay_as_you_go_from_earnings: boolean("pay_as_you_go_from_earnings").default(true).notNull(),

    // Steward auth tenant credentials for this organization.
    // Populated when an org is onboarded onto Steward-backed auth.
    steward_tenant_id: text("steward_tenant_id").unique(),
    steward_tenant_api_key: text("steward_tenant_api_key"),

    is_active: boolean("is_active").default(true).notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    slug_idx: index("organizations_slug_idx").on(table.slug),
    // CHECK constraint to prevent negative credit balances at database level
    credit_balance_non_negative: check(
      "credit_balance_non_negative",
      sql`${table.credit_balance} >= 0`,
    ),
  }),
);

// Type inference
export type Organization = InferSelectModel<typeof organizations>;
export type NewOrganization = InferInsertModel<typeof organizations>;

// Steward tenant credential shape (returned after provisioning)
export interface StewardTenantCredentials {
  tenantId: string;
  apiKey: string;
}
