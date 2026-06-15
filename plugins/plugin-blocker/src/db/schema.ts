/**
 * Drizzle pgSchema('app_blocker') for @elizaos/plugin-blocker.
 *
 * MIGRATION NOTE: There is no existing drizzle schema in plugin-lifeops for the
 * blocker (the original SelfControl / appblocker engines used disk-backed
 * state files). This new schema replaces that — block_rules, active_sessions,
 * and allow_list tables — and is the new persistent store the migrated
 * services will write through.
 */

import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const blockerSchema = pgSchema("app_blocker");

export const blockRulesTable = blockerSchema.table(
  "block_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    target: text("target").notNull(),
    pattern: text("pattern").notNull(),
    notes: text("notes"),
    metadata: jsonb("metadata").default("{}").notNull(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
  },
  (table) => ({
    entityTargetIdx: index("idx_block_rules_entity_target").on(
      table.entityId,
      table.target,
    ),
    agentEntityIdx: index("idx_block_rules_agent_entity").on(
      table.agentId,
      table.entityId,
    ),
  }),
);

export const activeSessionsTable = blockerSchema.table(
  "active_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    target: text("target").notNull(),
    status: text("status").notNull(),
    rules: jsonb("rules").default("[]").notNull(),
    metadata: jsonb("metadata").default("{}").notNull(),
    startedAt: timestamp("started_at").default(sql`now()`).notNull(),
    endsAt: timestamp("ends_at"),
    endedAt: timestamp("ended_at"),
  },
  (table) => ({
    entityStatusIdx: index("idx_active_sessions_entity_status").on(
      table.entityId,
      table.status,
    ),
    agentEntityIdx: index("idx_active_sessions_agent_entity").on(
      table.agentId,
      table.entityId,
    ),
  }),
);

export const allowListTable = blockerSchema.table(
  "allow_list",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    target: text("target").notNull(),
    pattern: text("pattern").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
  },
  (table) => ({
    entityTargetIdx: index("idx_allow_list_entity_target").on(
      table.entityId,
      table.target,
    ),
    agentEntityIdx: index("idx_allow_list_agent_entity").on(
      table.agentId,
      table.entityId,
    ),
  }),
);

export type BlockRuleRow = typeof blockRulesTable.$inferSelect;
export type BlockRuleInsert = typeof blockRulesTable.$inferInsert;
export type ActiveSessionRow = typeof activeSessionsTable.$inferSelect;
export type ActiveSessionInsert = typeof activeSessionsTable.$inferInsert;
export type AllowListRow = typeof allowListTable.$inferSelect;
export type AllowListInsert = typeof allowListTable.$inferInsert;
