import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const goalsTable = pgTable(
  "goals",
  {
    id: uuid("id").notNull().primaryKey(),
    agentId: uuid("agent_id").notNull(), // The agent managing this goal
    ownerType: text("owner_type").notNull(), // 'agent' or 'entity'
    ownerId: uuid("owner_id").notNull(), // Either agentId or entityId
    name: text("name").notNull(),
    description: text("description"),
    isCompleted: boolean("is_completed").default(false),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  },
  (table) => ({
    agentIdIndex: index("idx_goals_agent").on(table.agentId),
    ownerTypeIndex: index("idx_goals_owner_type").on(table.ownerType),
    ownerIdIndex: index("idx_goals_owner_id").on(table.ownerId),
    completedIndex: index("idx_goals_completed").on(table.isCompleted),
    createdAtIndex: index("idx_goals_created_at").on(table.createdAt),
  })
);

export const goalTagsTable = pgTable(
  "goal_tags",
  {
    id: uuid("id").notNull().primaryKey(),
    goalId: uuid("goal_id")
      .references(() => goalsTable.id, {
        onDelete: "cascade",
      })
      .notNull(),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    goalIdIndex: index("idx_goal_tags_goal").on(table.goalId),
    tagIndex: index("idx_goal_tags_tag").on(table.tag),
    uniqueGoalTag: uniqueIndex("unique_goal_tag").on(table.goalId, table.tag),
  })
);

export const goalsRelations = relations(goalsTable, ({ many }) => ({
  tags: many(goalTagsTable),
}));

export const goalTagsRelations = relations(goalTagsTable, ({ one }) => ({
  goal: one(goalsTable, {
    fields: [goalTagsTable.goalId],
    references: [goalsTable.id],
  }),
}));

export const goalSchema = {
  goalsTable,
  goalTagsTable,
  tables: {
    goals: goalsTable,
    goalTags: goalTagsTable,
  },
};

export default goalSchema;
