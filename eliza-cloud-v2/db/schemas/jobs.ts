import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import { organizations } from "./organizations";
import { users } from "./users";
import { apiKeys } from "./api-keys";
import { generations } from "./generations";

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
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
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
  }),
);

// Type inference
export type Job = InferSelectModel<typeof jobs>;
export type NewJob = InferInsertModel<typeof jobs>;
