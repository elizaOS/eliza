import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";

/**
 * Organizations table schema.
 *
 * Represents a billing organization that can contain multiple users.
 * Manages credit balance, billing settings, and usage quotas.
 */
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    credit_balance: numeric("credit_balance", { precision: 10, scale: 2 })
      .notNull()
      .default("100.00"),
    webhook_url: text("webhook_url"),
    webhook_secret: text("webhook_secret"),
    stripe_customer_id: text("stripe_customer_id"),
    billing_email: text("billing_email"),
    tax_id_type: text("tax_id_type"),
    tax_id_value: text("tax_id_value"),
    billing_address: jsonb("billing_address").$type<Record<string, unknown>>(),
    stripe_payment_method_id: text("stripe_payment_method_id"),
    stripe_default_payment_method: text("stripe_default_payment_method"),
    auto_top_up_enabled: boolean("auto_top_up_enabled")
      .default(false)
      .notNull(),
    auto_top_up_amount: numeric("auto_top_up_amount", {
      precision: 10,
      scale: 2,
    }),
    auto_top_up_threshold: numeric("auto_top_up_threshold", {
      precision: 10,
      scale: 2,
    }).default("0.00"),
    auto_top_up_subscription_id: text("auto_top_up_subscription_id"),
    max_api_requests: integer("max_api_requests").default(1000),
    max_tokens_per_request: integer("max_tokens_per_request"),
    allowed_models: jsonb("allowed_models")
      .$type<string[]>()
      .notNull()
      .default([]),
    allowed_providers: jsonb("allowed_providers")
      .$type<string[]>()
      .notNull()
      .default([]),
    is_active: boolean("is_active").default(true).notNull(),
    settings: jsonb("settings")
      .$type<Record<string, unknown>>()
      .default({})
      .notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    slug_idx: index("organizations_slug_idx").on(table.slug),
    stripe_customer_idx: index("organizations_stripe_customer_idx").on(
      table.stripe_customer_id,
    ),
    auto_top_up_enabled_idx: index("organizations_auto_top_up_enabled_idx").on(
      table.auto_top_up_enabled,
    ),
    // CHECK constraint to prevent negative credit balances at database level
    // This provides a second line of defense against race conditions
    credit_balance_non_negative: check(
      "credit_balance_non_negative",
      sql`${table.credit_balance} >= 0`,
    ),
  }),
);

// Type inference
export type Organization = InferSelectModel<typeof organizations>;
export type NewOrganization = InferInsertModel<typeof organizations>;
