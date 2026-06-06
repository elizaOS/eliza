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
 * Migrated from plugins/plugin-lifeops/src/lifeops/schema.ts where the
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

export const routinesTable = goalsSchema.table(
  "routines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    name: text("name").notNull(),
    cadence: text("cadence").notNull(),
    timeOfDay: text("time_of_day"),
    status: text("status").notNull().default("active"),
    metadata: jsonb("metadata").default("{}").notNull(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
  },
  (table) => ({
    entityIdx: index("idx_routines_entity").on(table.entityId),
  }),
);

export const remindersTable = goalsSchema.table(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    dueAt: timestamp("due_at"),
    source: text("source"),
    status: text("status").notNull().default("pending"),
    metadata: jsonb("metadata").default("{}").notNull(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
  },
  (table) => ({
    entityDueIdx: index("idx_reminders_entity_due").on(
      table.entityId,
      table.dueAt,
    ),
  }),
);

export const alarmsTable = goalsSchema.table(
  "alarms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    label: text("label").notNull(),
    fireAt: timestamp("fire_at").notNull(),
    repeatRule: text("repeat_rule"),
    status: text("status").notNull().default("scheduled"),
    metadata: jsonb("metadata").default("{}").notNull(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
    updatedAt: timestamp("updated_at").default(sql`now()`).notNull(),
  },
  (table) => ({
    entityFireIdx: index("idx_alarms_entity_fire").on(
      table.entityId,
      table.fireAt,
    ),
  }),
);

export const checkinsTable = goalsSchema.table(
  "checkins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").notNull(),
    entityId: uuid("entity_id").notNull(),
    kind: text("kind").notNull(),
    mood: text("mood"),
    notes: text("notes"),
    payload: jsonb("payload").default("{}").notNull(),
    occurredAt: timestamp("occurred_at").default(sql`now()`).notNull(),
    createdAt: timestamp("created_at").default(sql`now()`).notNull(),
  },
  (table) => ({
    entityTimeIdx: index("idx_checkins_entity_time").on(
      table.entityId,
      table.occurredAt,
    ),
  }),
);

export type GoalRow = typeof goalsTable.$inferSelect;
export type GoalInsert = typeof goalsTable.$inferInsert;
export type RoutineRow = typeof routinesTable.$inferSelect;
export type RoutineInsert = typeof routinesTable.$inferInsert;
export type ReminderRow = typeof remindersTable.$inferSelect;
export type ReminderInsert = typeof remindersTable.$inferInsert;
export type AlarmRow = typeof alarmsTable.$inferSelect;
export type AlarmInsert = typeof alarmsTable.$inferInsert;
export type CheckinRow = typeof checkinsTable.$inferSelect;
export type CheckinInsert = typeof checkinsTable.$inferInsert;
