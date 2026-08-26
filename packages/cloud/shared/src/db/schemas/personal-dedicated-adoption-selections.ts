/** Admin-reviewed selection of one existing personal Dedicated adoption candidate. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./organizations";
import { users } from "./users";

export const personalDedicatedAdoptionSelections = pgTable(
  "personal_dedicated_adoption_selections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source_agent_id: text("source_agent_id").notNull(),
    // Deliberately not an FK: this receipt must survive target deletion so the
    // resolver fails closed instead of falling back to another stale row.
    dedicated_agent_id: uuid("dedicated_agent_id").notNull(),
    selected_by_user_id: uuid("selected_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    selection_reason: text("selection_reason").notNull(),
    state_disposition: text("state_disposition").notNull(),
    activation_kind: text("activation_kind").notNull(),
    // Deliberately not an FK: a reviewed exact restore directive must survive
    // backup-row deletion and then fail closed in provisioning.
    activation_backup_id: uuid("activation_backup_id"),
    activation_backup_hash: text("activation_backup_hash"),
    activation_backup_chain: jsonb("activation_backup_chain"),
    inventory_fingerprint: text("inventory_fingerprint").notNull(),
    candidate_count: integer("candidate_count").notNull(),
    schema_version: integer("schema_version").notNull().default(1),
    selected_at: timestamp("selected_at", { withTimezone: true }).notNull().defaultNow(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    source_unique: unique("personal_dedicated_adoption_selections_source_unique").on(
      table.organization_id,
      table.user_id,
      table.source_agent_id,
    ),
    target_unique: unique("personal_dedicated_adoption_selections_target_unique").on(
      table.dedicated_agent_id,
    ),
    version_check: check(
      "personal_dedicated_adoption_selections_version_check",
      sql`${table.schema_version} = 1`,
    ),
    reason_check: check(
      "personal_dedicated_adoption_selections_reason_check",
      sql`${table.selection_reason} = 'duplicate_owned_dedicated_inventory'`,
    ),
    state_disposition_check: check(
      "personal_dedicated_adoption_selections_state_disposition_check",
      sql`${table.state_disposition} IN ('verified_backup_present', 'fresh_boot_no_verified_backup')`,
    ),
    activation_check: check(
      "personal_dedicated_adoption_selections_activation_check",
      sql`(
        ${table.activation_kind} = 'fresh_boot'
        AND ${table.activation_backup_id} IS NULL
        AND ${table.activation_backup_hash} IS NULL
        AND ${table.activation_backup_chain} IS NULL
      ) OR (
        ${table.activation_kind} = 'legacy_backup'
        AND ${table.activation_backup_id} IS NOT NULL
        AND ${table.activation_backup_hash} ~ '^[a-f0-9]{64}$'
        AND jsonb_typeof(${table.activation_backup_chain}) = 'array'
        AND jsonb_array_length(${table.activation_backup_chain}) > 0
      ) OR (
        ${table.activation_kind} = 'catalog_restore_required'
        AND ${table.activation_backup_id} IS NOT NULL
        AND ${table.activation_backup_hash} ~ '^[a-f0-9]{64}$'
        AND ${table.activation_backup_chain} IS NULL
      )`,
    ),
    fingerprint_check: check(
      "personal_dedicated_adoption_selections_fingerprint_check",
      sql`${table.inventory_fingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    candidate_count_check: check(
      "personal_dedicated_adoption_selections_candidate_count_check",
      sql`${table.candidate_count} >= 2`,
    ),
  }),
);

export type PersonalDedicatedAdoptionSelection = InferSelectModel<
  typeof personalDedicatedAdoptionSelections
>;
export type NewPersonalDedicatedAdoptionSelection = InferInsertModel<
  typeof personalDedicatedAdoptionSelections
>;
