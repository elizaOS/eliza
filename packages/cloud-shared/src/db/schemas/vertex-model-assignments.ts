import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";
import { vertexTunedModels } from "./vertex-tuned-models";
import { vertexTuningScopeEnum, vertexTuningSlotEnum } from "./vertex-tuning-jobs";

export const vertexModelAssignments = pgTable(
  "vertex_model_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: vertexTuningScopeEnum("scope").notNull(),
    slot: vertexTuningSlotEnum("slot").notNull(),
    organization_id: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    user_id: uuid("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    tuned_model_id: uuid("tuned_model_id")
      .notNull()
      .references(() => vertexTunedModels.id, { onDelete: "cascade" }),
    assigned_by_user_id: uuid("assigned_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    is_active: boolean("is_active").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    activated_at: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
    deactivated_at: timestamp("deactivated_at", { withTimezone: true }),
  },
  (table) => ({
    tuned_model_idx: index("vertex_model_assignments_tuned_model_idx").on(table.tuned_model_id),
    scope_idx: index("vertex_model_assignments_scope_idx").on(table.scope),
    slot_idx: index("vertex_model_assignments_slot_idx").on(table.slot),
    organization_idx: index("vertex_model_assignments_organization_idx").on(table.organization_id),
    user_idx: index("vertex_model_assignments_user_idx").on(table.user_id),
    active_idx: index("vertex_model_assignments_active_idx").on(table.is_active),
    global_slot_unique: uniqueIndex("vertex_model_assignments_global_slot_active_idx")
      .on(table.slot)
      .where(sql`${table.scope} = 'global' and ${table.is_active} = true`),
    organization_slot_unique: uniqueIndex("vertex_model_assignments_org_slot_active_idx")
      .on(table.organization_id, table.slot)
      .where(sql`${table.scope} = 'organization' and ${table.is_active} = true`),
    user_slot_unique: uniqueIndex("vertex_model_assignments_user_slot_active_idx")
      .on(table.user_id, table.slot)
      .where(sql`${table.scope} = 'user' and ${table.is_active} = true`),
    scope_owner_check: check(
      "vertex_model_assignments_scope_owner_check",
      sql`(
        (${table.scope} = 'global' and ${table.organization_id} is null and ${table.user_id} is null) or
        (${table.scope} = 'organization' and ${table.organization_id} is not null and ${table.user_id} is null) or
        (${table.scope} = 'user' and ${table.organization_id} is not null and ${table.user_id} is not null)
      )`,
    ),
  }),
);

export type VertexModelAssignmentRecord = InferSelectModel<typeof vertexModelAssignments>;
export type NewVertexModelAssignmentRecord = InferInsertModel<typeof vertexModelAssignments>;
