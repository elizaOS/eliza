import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema for plugin-goals.
 *
 * Migrated from plugins/plugin-personal-assistant/src/lifeops/schema.ts where the
 * `app_goals` namespace (life goals, routines, reminders, alarms, check-ins)
 * previously lived alongside the rest of LifeOps. The runtime registers this
 * schema through `@elizaos/plugin-sql`.
 */
export const goalsSchema = pgSchema("app_goals");

export const goalsTable = goalsSchema.table(
  "goals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    horizon: text("horizon"),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").default("{}").notNull(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
    archivedAt: timestamp("archived_at"),
  },
  (table) => ({
    entityIdx: index("idx_goals_entity").on(table.entityId),
    statusIdx: index("idx_goals_status").on(table.status),
  }),
);

export type GoalRow = typeof goalsTable.$inferSelect;
export type GoalInsert = typeof goalsTable.$inferInsert;
