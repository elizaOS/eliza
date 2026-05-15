import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  decimal,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Provider health table schema.
 *
 * Tracks health status and performance metrics for AI model providers.
 */
export const providerHealth = pgTable(
  "provider_health",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    status: text("status").notNull().default("healthy"),
    last_checked: timestamp("last_checked").notNull().defaultNow(),
    response_time: integer("response_time"),
    error_rate: decimal("error_rate", { precision: 5, scale: 4 }).default("0"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    provider_idx: index("provider_health_provider_idx").on(table.provider),
    status_idx: index("provider_health_status_idx").on(table.status),
  }),
);

// Type inference
export type ProviderHealth = InferSelectModel<typeof providerHealth>;
export type NewProviderHealth = InferInsertModel<typeof providerHealth>;
