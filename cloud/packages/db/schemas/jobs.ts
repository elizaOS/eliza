import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { apiKeys } from "./api-keys";
import { generations } from "./generations";
import { organizations } from "./organizations";
import { users } from "./users";

/**
 * Jobs table schema.
 *
 * Tracks background job execution with retry logic and webhook support.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: text("type").notNull(),
    status: text("status").notNull().default("pending"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    data_storage: text("data_storage").notNull().default("inline"),
    data_key: text("data_key"),
    agent_id: text("agent_id"),
    character_id: text("character_id"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    result_storage: text("result_storage").notNull().default("inline"),
    result_key: text("result_key"),
    error: text("error"),
    error_storage: text("error_storage").notNull().default("inline"),
    error_key: text("error_key"),
    attempts: integer("attempts").notNull().default(0),
    max_attempts: integer("max_attempts").notNull().default(3),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id").references(() => users.id),
    api_key_id: uuid("api_key_id").references(() => apiKeys.id),
    generation_id: uuid("generation_id").references(() => generations.id),
    webhook_url: text("webhook_url"),
    webhook_status: text("webhook_status"),
    estimated_completion_at: timestamp("estimated_completion_at"),
    scheduled_for: timestamp("scheduled_for").notNull().defaultNow(),
    started_at: timestamp("started_at"),
    completed_at: timestamp("completed_at"),
    created_at: timestamp("created_at").notNull().defaultNow(),
    updated_at: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    type_idx: index("jobs_type_idx").on(table.type),
    status_idx: index("jobs_status_idx").on(table.status),
    scheduled_for_idx: index("jobs_scheduled_for_idx").on(table.scheduled_for),
    organization_idx: index("jobs_organization_idx").on(table.organization_id),
    type_status_scheduled_idx: index("jobs_type_status_scheduled_idx").on(
      table.type,
      table.status,
      table.scheduled_for,
    ),
    org_type_agent_created_idx: index("jobs_org_type_agent_created_idx")
      .on(table.organization_id, table.type, table.agent_id, table.created_at)
      .where(sql`${table.agent_id} IS NOT NULL`),
    org_type_character_created_idx: index("jobs_org_type_character_created_idx")
      .on(table.organization_id, table.type, table.character_id, table.created_at)
      .where(sql`${table.character_id} IS NOT NULL`),
    active_provision_agent_idx: index("jobs_active_provision_agent_idx")
      .on(table.organization_id, table.agent_id, table.status)
      .where(sql`${table.type} = 'agent_provision' AND ${table.agent_id} IS NOT NULL`),
    pending_claim_idx: index("jobs_pending_claim_idx")
      .on(table.type, table.scheduled_for, table.created_at)
      .where(sql`${table.status} = 'pending'`),
  }),
);

// Type inference
export type Job = InferSelectModel<typeof jobs>;
export type NewJob = InferInsertModel<typeof jobs>;
