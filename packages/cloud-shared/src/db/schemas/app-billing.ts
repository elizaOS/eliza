import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, integer, numeric, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { apps } from "./apps";

/**
 * App billing table schema.
 *
 * DEPRECATED / STRANDED — do NOT read or write the monetization columns here.
 * The `apps` table is the single source of truth for monetization
 * (`monetization_enabled`, `inference_markup_percentage`,
 * `purchase_share_percentage`, `platform_offset_amount`,
 * `total_creator_earnings`, `total_platform_revenue`). The hot path
 * (`app-credits.ts`, `app-earnings.ts`, `x402-payment-requests.ts`) reads/writes
 * `apps` exclusively. The columns below duplicate those with divergent defaults
 * (e.g. purchase_share 10.00 vs apps' 0) but are never queried — only this
 * schema and the drizzle `apps.billing` relation reference the table, and the
 * `AppBilling` type has no consumers. Reading these columns would reintroduce
 * source-of-truth drift. This table is a drop candidate pending a migration that
 * first confirms it holds no rows in production.
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
