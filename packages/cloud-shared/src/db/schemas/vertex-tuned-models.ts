import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";
import {
  vertexTuningJobs,
  vertexTuningScopeEnum,
  vertexTuningSlotEnum,
} from "./vertex-tuning-jobs";

export const vertexTunedModels = pgTable(
  "vertex_tuned_models",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tuning_job_id: uuid("tuning_job_id").references(() => vertexTuningJobs.id, {
      onDelete: "set null",
    }),
    vertex_model_id: text("vertex_model_id").notNull(),
    display_name: text("display_name").notNull(),
    base_model: text("base_model").notNull(),
    project_id: text("project_id").notNull(),
    region: text("region").notNull(),
    slot: vertexTuningSlotEnum("slot").notNull(),
    source_scope: vertexTuningScopeEnum("source_scope").notNull(),
    organization_id: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    model_preferences: jsonb("model_preferences")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    vertex_model_id_idx: uniqueIndex("vertex_tuned_models_vertex_model_id_idx").on(
      table.vertex_model_id,
    ),
    tuning_job_idx: index("vertex_tuned_models_tuning_job_idx").on(table.tuning_job_id),
    slot_idx: index("vertex_tuned_models_slot_idx").on(table.slot),
    source_scope_idx: index("vertex_tuned_models_source_scope_idx").on(table.source_scope),
    organization_idx: index("vertex_tuned_models_organization_idx").on(table.organization_id),
    user_idx: index("vertex_tuned_models_user_idx").on(table.user_id),
    scope_owner_check: check(
      "vertex_tuned_models_scope_owner_check",
      sql`(
        (${table.source_scope} = 'global' and ${table.organization_id} is null and ${table.user_id} is null) or
        (${table.source_scope} = 'organization' and ${table.organization_id} is not null and ${table.user_id} is null) or
        (${table.source_scope} = 'user' and ${table.organization_id} is not null and ${table.user_id} is not null)
      )`,
    ),
  }),
);

export type VertexTunedModelRecord = InferSelectModel<typeof vertexTunedModels>;
export type NewVertexTunedModelRecord = InferInsertModel<typeof vertexTunedModels>;
