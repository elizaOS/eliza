import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  bigint,
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
import { usageRecords } from "./usage-records";
import { users } from "./users";

/**
 * Generations table schema.
 *
 * Stores image and video generation requests and results with cost tracking.
 */
export const generations = pgTable(
  "generations",
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
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    prompt: text("prompt").notNull(),
    prompt_storage: text("prompt_storage").notNull().default("inline"),
    prompt_key: text("prompt_key"),
    negative_prompt: text("negative_prompt"),
    negative_prompt_storage: text("negative_prompt_storage").notNull().default("inline"),
    negative_prompt_key: text("negative_prompt_key"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    result_storage: text("result_storage").notNull().default("inline"),
    result_key: text("result_key"),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    storage_url: text("storage_url"),
    thumbnail_url: text("thumbnail_url"),
    content: text("content"),
    content_storage: text("content_storage").notNull().default("inline"),
    content_key: text("content_key"),
    file_size: bigint("file_size", { mode: "bigint" }),
    mime_type: text("mime_type"),
    parameters: jsonb("parameters").$type<Record<string, unknown>>(),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    dimensions: jsonb("dimensions").$type<{
      width?: number;
      height?: number;
      duration?: number;
    }>(),
    tokens: integer("tokens"),
    cost: numeric("cost", { precision: 10, scale: 2 }).notNull().default("0.00"),
    credits: numeric("credits", { precision: 10, scale: 2 }).notNull().default("0.00"),
    usage_record_id: uuid("usage_record_id").references(() => usageRecords.id, {
      onDelete: "set null",
    }),
    is_public: boolean("is_public").notNull().default(false),
    job_id: text("job_id"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
    completed_at: timestamp("completed_at"),
  },
  (table) => ({
    organization_idx: index("generations_organization_idx").on(table.organization_id),
    user_idx: index("generations_user_idx").on(table.user_id),
    api_key_idx: index("generations_api_key_idx").on(table.api_key_id),
    type_idx: index("generations_type_idx").on(table.type),
    status_idx: index("generations_status_idx").on(table.status),
    created_at_idx: index("generations_created_at_idx").on(table.created_at),
    org_type_status_idx: index("generations_org_type_status_idx").on(
      table.organization_id,
      table.type,
      table.status,
    ),
    // Composite index for gallery queries: org + status + user + created_at ordering
    org_status_user_created_idx: index("generations_org_status_user_created_idx").on(
      table.organization_id,
      table.status,
      table.user_id,
      table.created_at,
    ),
  }),
);

// Type inference
export type Generation = InferSelectModel<typeof generations>;
export type NewGeneration = InferInsertModel<typeof generations>;
