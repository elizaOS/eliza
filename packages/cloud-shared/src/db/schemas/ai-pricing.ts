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

export type PricingDimensionValue = string | number | boolean | null;
export type PricingDimensions = Record<string, PricingDimensionValue>;

/**
 * Canonical AI pricing catalog.
 *
 * Each row represents one billable price component for a provider/model pair,
 * scoped by billing source and optional dimensions such as duration, audio,
 * resolution, size, or quality.
 */
export const aiPricingEntries = pgTable(
  "ai_pricing_entries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    billing_source: text("billing_source").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    product_family: text("product_family").notNull(),
    charge_type: text("charge_type").notNull(),
    unit: text("unit").notNull(),
    unit_price: numeric("unit_price", { precision: 20, scale: 10 }).notNull(),
    currency: text("currency").notNull().default("USD"),
    dimension_key: text("dimension_key").notNull().default("*"),
    dimensions: jsonb("dimensions").$type<PricingDimensions>().notNull().default({}),
    source_kind: text("source_kind").notNull(),
    source_url: text("source_url").notNull(),
    source_hash: text("source_hash"),
    fetched_at: timestamp("fetched_at"),
    stale_after: timestamp("stale_after"),
    effective_from: timestamp("effective_from").notNull().defaultNow(),
    effective_until: timestamp("effective_until"),
    priority: integer("priority").notNull().default(0),
    is_active: boolean("is_active").notNull().default(true),
    is_override: boolean("is_override").notNull().default(false),
    updated_by: text("updated_by"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    lookup_idx: index("ai_pricing_entries_lookup_idx").on(
      table.billing_source,
      table.provider,
      table.model,
      table.product_family,
      table.charge_type,
      table.is_active,
    ),
    dimension_idx: index("ai_pricing_entries_dimension_idx").on(
      table.dimension_key,
      table.priority,
    ),
    freshness_idx: index("ai_pricing_entries_freshness_idx").on(
      table.source_kind,
      table.fetched_at,
      table.stale_after,
    ),
  }),
);

/**
 * Audit log for pricing refresh jobs.
 */
export const aiPricingRefreshRuns = pgTable(
  "ai_pricing_refresh_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    source_url: text("source_url"),
    fetched_entries: integer("fetched_entries").notNull().default(0),
    upserted_entries: integer("upserted_entries").notNull().default(0),
    deactivated_entries: integer("deactivated_entries").notNull().default(0),
    error: text("error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    started_at: timestamp("started_at").notNull().defaultNow(),
    completed_at: timestamp("completed_at"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    source_status_idx: index("ai_pricing_refresh_runs_source_status_idx").on(
      table.source,
      table.status,
    ),
    started_idx: index("ai_pricing_refresh_runs_started_idx").on(table.started_at),
  }),
);

export type AiPricingEntry = InferSelectModel<typeof aiPricingEntries>;
export type NewAiPricingEntry = InferInsertModel<typeof aiPricingEntries>;
export type AiPricingRefreshRun = InferSelectModel<typeof aiPricingRefreshRuns>;
export type NewAiPricingRefreshRun = InferInsertModel<typeof aiPricingRefreshRuns>;
