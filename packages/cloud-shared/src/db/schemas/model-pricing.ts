import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  decimal,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Model pricing table schema.
 *
 * Stores pricing information for AI models by provider, used for cost calculation.
 */
export const modelPricing = pgTable(
  "model_pricing",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    input_cost_per_1k: decimal("input_cost_per_1k", {
      precision: 10,
      scale: 6,
    }).notNull(),
    output_cost_per_1k: decimal("output_cost_per_1k", {
      precision: 10,
      scale: 6,
    }).notNull(),
    input_cost_per_token: decimal("input_cost_per_token", {
      precision: 10,
      scale: 6,
    }),
    output_cost_per_token: decimal("output_cost_per_token", {
      precision: 10,
      scale: 6,
    }),
    is_active: boolean("is_active").notNull().default(true),
    effective_from: timestamp("effective_from").notNull().defaultNow(),
    effective_until: timestamp("effective_until"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    provider_model_idx: index("model_pricing_provider_model_idx").on(table.provider, table.model),
    active_idx: index("model_pricing_active_idx").on(table.is_active),
  }),
);

// Type inference
export type ModelPricing = InferSelectModel<typeof modelPricing>;
export type NewModelPricing = InferInsertModel<typeof modelPricing>;
