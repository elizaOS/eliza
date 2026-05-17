import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, integer, numeric, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { apps } from "./apps";

/**
 * App billing table schema.
 *
 * Stores monetization settings, pricing overrides, rate limits, and creator earnings.
 * Split from the main apps table to reduce row size on the heavily-read core table.
 */
export const appBilling = pgTable(
  "app_billing",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    app_id: uuid("app_id")
      .notNull()
      .unique()
      .references(() => apps.id, { onDelete: "cascade" }),

    // Pricing overrides
    custom_pricing_enabled: boolean("custom_pricing_enabled").default(false).notNull(),

    // Monetization settings
    monetization_enabled: boolean("monetization_enabled").default(false).notNull(),
    inference_markup_percentage: numeric("inference_markup_percentage", {
      precision: 7,
      scale: 2,
    })
      .default("0.00")
      .notNull(),
    purchase_share_percentage: numeric("purchase_share_percentage", {
      precision: 5,
      scale: 2,
    })
      .default("10.00")
      .notNull(),
    platform_offset_amount: numeric("platform_offset_amount", {
      precision: 10,
      scale: 2,
    })
      .default("1.00")
      .notNull(),

    // Creator earnings tracking (summary)
    total_creator_earnings: numeric("total_creator_earnings", {
      precision: 12,
      scale: 6,
    })
      .default("0.000000")
      .notNull(),
    total_platform_revenue: numeric("total_platform_revenue", {
      precision: 12,
      scale: 6,
    })
      .default("0.000000")
      .notNull(),

    // Rate limiting
    rate_limit_per_minute: integer("rate_limit_per_minute").default(60),
    rate_limit_per_hour: integer("rate_limit_per_hour").default(1000),

    // Lifecycle
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    app_idx: index("app_billing_app_idx").on(table.app_id),
  }),
);

// Type inference
export type AppBilling = InferSelectModel<typeof appBilling>;
export type NewAppBilling = InferInsertModel<typeof appBilling>;
