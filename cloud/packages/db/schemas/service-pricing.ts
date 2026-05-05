import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Service pricing table schema.
 *
 * Stores per-method pricing for proxy services (e.g., Solana RPC, market data).
 * Pricing is cached in Redis and can be updated via admin API without code deploys.
 */
export const servicePricing = pgTable(
  "service_pricing",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    service_id: text("service_id").notNull(),
    method: text("method").notNull(),
    cost: numeric("cost", { precision: 12, scale: 6 }).notNull(),
    description: text("description"),
    metadata: jsonb("metadata")
      .$type<Record<string, string | number | boolean | null>>()
      .default({})
      .notNull(),
    is_active: boolean("is_active").default(true).notNull(),
    updated_by: text("updated_by"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    service_method_unique: uniqueIndex("service_pricing_service_method_idx").on(
      table.service_id,
      table.method,
    ),
  }),
);

/**
 * Service pricing audit log table schema.
 *
 * Append-only audit trail for all pricing changes.
 * Tracks who changed what, when, and why.
 *
 * IMPORTANT: Uses ON DELETE SET NULL to preserve audit history even when
 * pricing records are deleted. The service_id and method columns provide
 * sufficient context for historical analysis.
 */
export const servicePricingAudit = pgTable(
  "service_pricing_audit",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    service_pricing_id: uuid("service_pricing_id").references(() => servicePricing.id, {
      onDelete: "set null",
    }),
    service_id: text("service_id").notNull(),
    method: text("method").notNull(),
    old_cost: numeric("old_cost", { precision: 12, scale: 6 }),
    new_cost: numeric("new_cost", { precision: 12, scale: 6 }).notNull(),
    change_type: text("change_type").notNull(),
    changed_by: text("changed_by").notNull(),
    reason: text("reason"),
    ip_address: text("ip_address"),
    user_agent: text("user_agent"),
    created_at: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    service_idx: index("service_pricing_audit_service_idx").on(table.service_id),
    pricing_id_created_idx: index("service_pricing_audit_pricing_created_idx").on(
      table.service_pricing_id,
      table.created_at,
    ),
  }),
);

export type ServicePricing = InferSelectModel<typeof servicePricing>;
export type NewServicePricing = InferInsertModel<typeof servicePricing>;
export type ServicePricingAudit = InferSelectModel<typeof servicePricingAudit>;
export type NewServicePricingAudit = InferInsertModel<typeof servicePricingAudit>;
