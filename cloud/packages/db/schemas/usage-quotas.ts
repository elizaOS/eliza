import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { boolean, index, numeric, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Usage quotas table schema.
 *
 * Defines usage limits for organizations, supporting both global and model-specific quotas.
 */
export const usageQuotas = pgTable(
  "usage_quotas",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),

    quota_type: text("quota_type").notNull(),

    model_name: text("model_name"),

    period_type: text("period_type").notNull().default("weekly"),

    credits_limit: numeric("credits_limit", {
      precision: 10,
      scale: 2,
    }).notNull(),

    current_usage: numeric("current_usage", { precision: 10, scale: 2 }).default("0.00").notNull(),

    period_start: timestamp("period_start").notNull(),

    period_end: timestamp("period_end").notNull(),

    is_active: boolean("is_active").default(true).notNull(),

    created_at: timestamp("created_at").notNull().defaultNow(),

    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    org_id_idx: index("usage_quotas_org_id_idx").on(table.organization_id),
    quota_type_idx: index("usage_quotas_quota_type_idx").on(table.quota_type),
    period_idx: index("usage_quotas_period_idx").on(table.period_start, table.period_end),
    active_idx: index("usage_quotas_active_idx").on(table.is_active),
  }),
);

export type UsageQuota = InferSelectModel<typeof usageQuotas>;
export type NewUsageQuota = InferInsertModel<typeof usageQuotas>;
