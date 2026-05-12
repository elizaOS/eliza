import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
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
import { apiKeys } from "./api-keys";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * Usage records table schema.
 *
 * Tracks API usage including token consumption, costs, and success rates.
 * Used for billing, analytics, and quota enforcement.
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    api_key_id: uuid("api_key_id").references(() => apiKeys.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    model: text("model"),
    provider: text("provider").notNull(),
    input_tokens: integer("input_tokens").notNull().default(0),
    output_tokens: integer("output_tokens").notNull().default(0),
    input_cost: numeric("input_cost", { precision: 12, scale: 6 }).default("0.000000"),
    output_cost: numeric("output_cost", { precision: 12, scale: 6 }).default("0.000000"),
    markup: numeric("markup", { precision: 12, scale: 6 }).default("0.000000"),
    request_id: text("request_id"),
    duration_ms: integer("duration_ms"),
    is_successful: boolean("is_successful").notNull().default(true),
    error_message: text("error_message"),
    ip_address: text("ip_address"),
    user_agent: text("user_agent"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    created_at: timestamp("created_at").notNull().defaultNow(),

    /** Matches `canonicalUsageGroupingModel()` in `@/lib/providers/model-id-translation`. */
    canonical_model: text("canonical_model").generatedAlwaysAs(
      sql`(CASE
        WHEN model IS NULL OR model::text = '' THEN '__null__'
        WHEN position('/'::text in (model::text)) > 0 THEN
          CASE
            WHEN model::text LIKE 'xai/%' THEN 'x-ai/' || substring(model::text from 5)
            WHEN model::text LIKE 'mistral/%' THEN 'mistralai/' || substring(model::text from 9)
            ELSE model
          END
        ELSE model
      END)`,
    ),
    /** Matches `normalizeProviderKey()` for usage breakdown SQL. */
    canonical_provider: text("canonical_provider").generatedAlwaysAs(
      sql`(CASE provider
        WHEN 'x-ai' THEN 'xai'
        WHEN 'mistralai' THEN 'mistral'
        ELSE provider
      END)`,
    ),
  },
  (table) => ({
    organization_idx: index("usage_records_organization_idx").on(table.organization_id),
    user_idx: index("usage_records_user_idx").on(table.user_id),
    api_key_idx: index("usage_records_api_key_idx").on(table.api_key_id),
    type_idx: index("usage_records_type_idx").on(table.type),
    provider_idx: index("usage_records_provider_idx").on(table.provider),
    created_at_idx: index("usage_records_created_at_idx").on(table.created_at),
    org_created_idx: index("usage_records_org_created_idx").on(
      table.organization_id,
      table.created_at,
    ),
    // Voice usage tracking indexes
    org_type_created_idx: index("usage_records_org_type_created_idx").on(
      table.organization_id,
      table.type,
      table.created_at,
    ),
    org_canonical_model_created_idx: index("usage_records_org_canonical_model_created_idx").on(
      table.organization_id,
      table.canonical_model,
      table.created_at,
    ),
    org_canonical_provider_created_idx: index(
      "usage_records_org_canonical_provider_created_idx",
    ).on(table.organization_id, table.canonical_provider, table.created_at),
  }),
);

// Type inference
export type UsageRecord = InferSelectModel<typeof usageRecords>;
export type NewUsageRecord = InferInsertModel<typeof usageRecords>;
