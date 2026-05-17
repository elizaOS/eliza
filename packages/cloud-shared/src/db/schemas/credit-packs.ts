import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Credit packs table schema.
 *
 * Stores purchasable credit packs with Stripe integration.
 */
export const creditPacks = pgTable(
  "credit_packs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    credits: numeric("credits", { precision: 10, scale: 2 }).notNull(),
    price_cents: integer("price_cents").notNull(),
    stripe_price_id: text("stripe_price_id").notNull().unique(),
    stripe_product_id: text("stripe_product_id").notNull(),
    is_active: boolean("is_active").notNull().default(true),
    sort_order: integer("sort_order").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    stripe_price_idx: index("credit_packs_stripe_price_idx").on(table.stripe_price_id),
    active_idx: index("credit_packs_active_idx").on(table.is_active),
    sort_idx: index("credit_packs_sort_idx").on(table.sort_order),
  }),
);

// Type inference
export type CreditPack = InferSelectModel<typeof creditPacks>;
export type NewCreditPack = InferInsertModel<typeof creditPacks>;
