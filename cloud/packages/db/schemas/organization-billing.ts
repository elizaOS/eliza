import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Organization billing table schema.
 *
 * Stores Stripe billing details, payment methods, and auto top-up configuration.
 * Split from the main organizations table to reduce row size on the heavily-read core table.
 */
export const organizationBilling = pgTable(
  "organization_billing",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .unique()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Stripe
    stripe_customer_id: text("stripe_customer_id"),
    billing_email: text("billing_email"),
    tax_id_type: text("tax_id_type"),
    tax_id_value: text("tax_id_value"),
    billing_address: jsonb("billing_address").$type<Record<string, unknown>>(),
    stripe_payment_method_id: text("stripe_payment_method_id"),
    stripe_default_payment_method: text("stripe_default_payment_method"),

    // Auto top-up
    auto_top_up_enabled: boolean("auto_top_up_enabled").default(false).notNull(),
    auto_top_up_amount: numeric("auto_top_up_amount", {
      precision: 12,
      scale: 6,
    }),
    auto_top_up_threshold: numeric("auto_top_up_threshold", {
      precision: 12,
      scale: 6,
    }).default("0.000000"),
    auto_top_up_subscription_id: text("auto_top_up_subscription_id"),

    // Lifecycle
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("org_billing_organization_idx").on(table.organization_id),
    stripe_customer_idx: index("org_billing_stripe_customer_idx").on(table.stripe_customer_id),
    auto_top_up_enabled_idx: index("org_billing_auto_top_up_enabled_idx").on(
      table.auto_top_up_enabled,
    ),
  }),
);

// Type inference
export type OrganizationBilling = InferSelectModel<typeof organizationBilling>;
export type NewOrganizationBilling = InferInsertModel<typeof organizationBilling>;
