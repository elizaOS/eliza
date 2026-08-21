/**
 * Defines the organizations Drizzle table shape used by cloud repositories and services.
 */
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  numeric,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const organizationBalanceRevisionSequence = pgSequence("organization_balance_revision_seq");
export const organizationSpendableRevisionSequence = pgSequence(
  "organization_spendable_revision_seq",
);

/**
 * Organizations table schema (core).
 *
 * Represents a billing organization that can contain multiple users.
 *
 * NOTE: `settings` is kept here because it's deeply used across many API routes
 * and container management. The organization_config table serves as a read-optimized
 * projection for less-frequently-accessed configuration.
 *
 * Billing identity and payment settings remain on this row because checkout,
 * auto-top-up, and credit mutation lock it as one atomic authority. The legacy
 * organization_billing table is a migration shadow, not an application read path.
 * Extended config → organization_config table
 */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    credit_balance: numeric("credit_balance", { precision: 16, scale: 6 })
      .notNull()
      // Accounts start at $0. Shared service access is not represented as paid
      // balance; only explicit funding and promotion paths add ledger credits.
      .default("0.000000"),
    // A database trigger advances this sequence-backed revision on every
    // credit-balance mutation. Cache-only inference admission uses it to reject
    // delayed stale snapshots that arrive after a newer debit or top-up. Zero
    // is the per-organization initial revision; only mutations need a globally
    // monotonic sequence value.
    balance_revision: bigint("balance_revision", { mode: "number" }).notNull().default(0),
    // Advances for either purchased-credit or subscription-allowance changes,
    // allowing cache admission to fence the complete spendable balance.
    spendable_revision: bigint("spendable_revision", { mode: "number" }).notNull().default(0),
    // Durable auto-top-up re-arms only after a balance decrease. Existing
    // organizations are conservatively fenced during migration; newly created
    // organizations start without a fence so their first eligible top-up can run.
    balance_decrease_revision: bigint("balance_decrease_revision", { mode: "number" })
      .notNull()
      .default(0),
    auto_top_up_covered_balance_decrease_revision: bigint(
      "auto_top_up_covered_balance_decrease_revision",
      { mode: "number" },
    ),

    // Settings (kept for backward compatibility with container management)
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}),

    // Canonical Stripe billing identity and payment settings.
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
    // When false, hosting is paid purely from credits for compatibility,
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
    stripe_customer_authority_unique: uniqueIndex("organizations_stripe_customer_authority_unique")
      .on(table.stripe_customer_id)
      .where(sql`${table.stripe_customer_id} IS NOT NULL`),
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
