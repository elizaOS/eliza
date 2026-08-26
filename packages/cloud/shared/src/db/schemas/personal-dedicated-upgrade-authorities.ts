/** Canonical server receipts for Shared-to-Dedicated ownership and cutover. */

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { agentSandboxes } from "./agent-sandboxes";
import { organizations } from "./organizations";
import { users } from "./users";

export const personalDedicatedUpgradeAuthorities = pgTable(
  "personal_dedicated_upgrade_authorities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source_agent_id: text("source_agent_id").notNull(),
    dedicated_agent_id: uuid("dedicated_agent_id")
      .notNull()
      .references(() => agentSandboxes.id, { onDelete: "cascade" }),
    schema_version: integer("schema_version").notNull().default(1),
    bound_at: timestamp("bound_at", { withTimezone: true }).notNull().defaultNow(),
    cutover_token: text("cutover_token"),
    shared_message_count: integer("shared_message_count"),
    shared_scheduled_task_count: integer("shared_scheduled_task_count"),
    shared_todo_count: integer("shared_todo_count"),
    shared_todo_mutation_count: integer("shared_todo_mutation_count"),
    shared_todo_digest: text("shared_todo_digest"),
    cutover_activated_at: timestamp("cutover_activated_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    source_unique: unique("personal_dedicated_upgrade_authorities_source_unique").on(
      table.organization_id,
      table.user_id,
      table.source_agent_id,
    ),
    target_unique: unique("personal_dedicated_upgrade_authorities_target_unique").on(
      table.dedicated_agent_id,
    ),
    version_check: check(
      "personal_dedicated_upgrade_authorities_version_check",
      sql`${table.schema_version} = 1`,
    ),
    cutover_check: check(
      "personal_dedicated_upgrade_authorities_cutover_check",
      sql`(
        ${table.cutover_token} IS NULL
        AND ${table.shared_message_count} IS NULL
        AND ${table.shared_scheduled_task_count} IS NULL
        AND ${table.shared_todo_count} IS NULL
        AND ${table.shared_todo_mutation_count} IS NULL
        AND ${table.shared_todo_digest} IS NULL
        AND ${table.cutover_activated_at} IS NULL
      ) OR (
        ${table.cutover_token} IS NOT NULL
        AND ${table.shared_message_count} >= 0
        AND ${table.shared_scheduled_task_count} >= 0
        AND ${table.shared_todo_count} >= 0
        AND ${table.shared_todo_mutation_count} >= 0
        AND ${table.shared_todo_digest} ~ '^[a-f0-9]{64}$'
        AND ${table.cutover_activated_at} IS NOT NULL
      )`,
    ),
  }),
);

export type PersonalDedicatedUpgradeAuthority = InferSelectModel<
  typeof personalDedicatedUpgradeAuthorities
>;
export type NewPersonalDedicatedUpgradeAuthority = InferInsertModel<
  typeof personalDedicatedUpgradeAuthorities
>;
