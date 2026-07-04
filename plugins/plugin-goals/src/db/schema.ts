/**
 * Drizzle definitions for the `app_goals` schema — the goal tables
 * (`life_goal_definitions`, `life_goal_links`) this plugin owns.
 *
 * Table and column names (and column order) mirror the `app_lifeops` originals
 * verbatim so the non-destructive `GoalsMigrationService` can copy existing rows
 * across on first boot. Registered with the runtime through `@elizaos/plugin-sql`.
 */
import { index, pgSchema, text, unique } from "drizzle-orm/pg-core";

export const goalsSchema = pgSchema("app_goals");

export const lifeGoalDefinitions = goalsSchema.table(
  "life_goal_definitions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    domain: text("domain").notNull().default("user_lifeops"),
    subjectType: text("subject_type").notNull().default("owner"),
    subjectId: text("subject_id").notNull(),
    visibilityScope: text("visibility_scope").notNull().default("owner_only"),
    contextPolicy: text("context_policy").notNull().default("explicit_only"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    cadenceJson: text("cadence_json"),
    supportStrategyJson: text("support_strategy_json").notNull().default("{}"),
    successCriteriaJson: text("success_criteria_json").notNull().default("{}"),
    status: text("status").notNull().default("active"),
    reviewState: text("review_state").notNull().default("pending"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_goal_definitions_agent_status").on(t.agentId, t.status),
    index("idx_life_goal_definitions_subject").on(
      t.agentId,
      t.domain,
      t.subjectType,
      t.subjectId,
      t.status,
    ),
  ],
);

export const lifeGoalLinks = goalsSchema.table(
  "life_goal_links",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    goalId: text("goal_id").notNull(),
    linkedType: text("linked_type").notNull(),
    linkedId: text("linked_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.goalId, t.linkedType, t.linkedId),
    index("idx_life_goal_links_goal").on(t.goalId),
    index("idx_life_goal_links_linked").on(t.linkedType, t.linkedId),
  ],
);

export const goalsDbSchema = {
  lifeGoalDefinitions,
  lifeGoalLinks,
} as const;

export type GoalDefinitionRow = typeof lifeGoalDefinitions.$inferSelect;
export type GoalLinkRow = typeof lifeGoalLinks.$inferSelect;
