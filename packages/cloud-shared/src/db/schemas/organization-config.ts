import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

/**
 * Organization config table schema.
 *
 * Stores webhook settings, rate limits, model/provider restrictions, and misc settings.
 * Split from the main organizations table to reduce row size on heavily-read core table.
 */
export const organizationConfig = pgTable(
  "organization_config",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .unique()
      .references(() => organizations.id, { onDelete: "cascade" }),

    // Webhooks
    webhook_url: text("webhook_url"),
    webhook_secret: text("webhook_secret"),

    // Rate limits
    max_api_requests: integer("max_api_requests").default(1000),
    max_tokens_per_request: integer("max_tokens_per_request"),

    // Model/provider restrictions
    allowed_models: jsonb("allowed_models").$type<string[]>().notNull().default([]),
    allowed_providers: jsonb("allowed_providers").$type<string[]>().notNull().default([]),

    // General settings
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),

    // Lifecycle
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    organization_idx: index("org_config_organization_idx").on(table.organization_id),
  }),
);

// Type inference
export type OrganizationConfig = InferSelectModel<typeof organizationConfig>;
export type NewOrganizationConfig = InferInsertModel<typeof organizationConfig>;
