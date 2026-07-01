import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export const vertexTuningScopeEnum = pgEnum("vertex_tuning_scope", [
  "global",
  "organization",
  "user",
]);

export const vertexTuningSlotEnum = pgEnum("vertex_tuning_slot", [
  "should_respond",
  "response_handler",
  "action_planner",
  "planner",
  "response",
  "media_description",
]);

export const vertexTuningJobStateEnum = pgEnum("vertex_tuning_job_state", [
  "JOB_STATE_PENDING",
  "JOB_STATE_RUNNING",
  "JOB_STATE_SUCCEEDED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
]);

export const vertexTuningJobs = pgTable(
  "vertex_tuning_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vertex_job_name: text("vertex_job_name").notNull(),
    project_id: text("project_id").notNull(),
    region: text("region").notNull(),
    display_name: text("display_name").notNull(),
    base_model: text("base_model").notNull(),
    slot: vertexTuningSlotEnum("slot").notNull(),
    scope: vertexTuningScopeEnum("scope").notNull(),
    organization_id: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    created_by_user_id: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    training_data_path: text("training_data_path").notNull(),
    validation_data_path: text("validation_data_path"),
    training_data_uri: text("training_data_uri"),
    validation_data_uri: text("validation_data_uri"),
    recommended_model_id: text("recommended_model_id"),
    tuned_model_display_name: text("tuned_model_display_name"),
    tuned_model_endpoint_name: text("tuned_model_endpoint_name"),
    status: vertexTuningJobStateEnum("status").notNull().default("JOB_STATE_PENDING"),
    error_code: integer("error_code"),
    error_message: text("error_message"),
    model_preference_patch: jsonb("model_preference_patch")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    last_remote_payload: jsonb("last_remote_payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    last_remote_payload_storage: text("last_remote_payload_storage").notNull().default("inline"),
    last_remote_payload_key: text("last_remote_payload_key"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completed_at: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => ({
    vertex_job_name_idx: uniqueIndex("vertex_tuning_jobs_vertex_job_name_idx").on(
      table.vertex_job_name,
    ),
    status_idx: index("vertex_tuning_jobs_status_idx").on(table.status),
    scope_idx: index("vertex_tuning_jobs_scope_idx").on(table.scope),
    organization_idx: index("vertex_tuning_jobs_organization_idx").on(table.organization_id),
    user_idx: index("vertex_tuning_jobs_user_idx").on(table.user_id),
    created_by_idx: index("vertex_tuning_jobs_created_by_idx").on(table.created_by_user_id),
    slot_idx: index("vertex_tuning_jobs_slot_idx").on(table.slot),
    created_at_idx: index("vertex_tuning_jobs_created_at_idx").on(table.created_at),
    scope_status_updated_idx: index("vertex_tuning_jobs_scope_status_updated_idx").on(
      table.scope,
      table.status,
      table.updated_at,
    ),
    scope_owner_check: check(
      "vertex_tuning_jobs_scope_owner_check",
      sql`(
        (${table.scope} = 'global' and ${table.organization_id} is null and ${table.user_id} is null) or
        (${table.scope} = 'organization' and ${table.organization_id} is not null and ${table.user_id} is null) or
        (${table.scope} = 'user' and ${table.organization_id} is not null and ${table.user_id} is not null)
      )`,
    ),
  }),
);

export type VertexTuningJobRecord = InferSelectModel<typeof vertexTuningJobs>;
export type NewVertexTuningJobRecord = InferInsertModel<typeof vertexTuningJobs>;
