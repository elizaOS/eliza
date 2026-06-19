import { boolean, index, integer, pgSchema, text } from "drizzle-orm/pg-core";

/**
 * Drizzle schema for plugin-reminders.
 *
 * The reminder tables (`life_reminder_plans`, `life_reminder_attempts`,
 * `life_escalation_states`) were carved out of
 * `@elizaos/plugin-personal-assistant`'s `app_lifeops` schema. Table + column
 * names are preserved verbatim so the non-destructive `RemindersMigrationService`
 * can copy existing `app_lifeops` rows into `app_reminders`. The runtime
 * registers this schema through `@elizaos/plugin-sql`.
 */
export const remindersSchema = pgSchema("app_reminders");

export const lifeReminderPlans = remindersSchema.table(
  "life_reminder_plans",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    stepsJson: text("steps_json").notNull().default("[]"),
    mutePolicyJson: text("mute_policy_json").notNull().default("{}"),
    quietHoursJson: text("quiet_hours_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_reminder_plans_owner").on(
      t.agentId,
      t.ownerType,
      t.ownerId,
    ),
  ],
);

export const lifeReminderAttempts = remindersSchema.table(
  "life_reminder_attempts",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    planId: text("plan_id").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    occurrenceId: text("occurrence_id"),
    channel: text("channel").notNull(),
    stepIndex: integer("step_index").notNull().default(0),
    scheduledFor: text("scheduled_for").notNull(),
    attemptedAt: text("attempted_at"),
    outcome: text("outcome").notNull().default("pending"),
    connectorRef: text("connector_ref"),
    deliveryMetadataJson: text("delivery_metadata_json")
      .notNull()
      .default("{}"),
    reviewAt: text("review_at"),
    reviewStatus: text("review_status"),
    reviewClaimedAt: text("review_claimed_at"),
    reviewClaimedBy: text("review_claimed_by"),
    reviewAttemptCount: integer("review_attempt_count").notNull().default(0),
    reviewNextRetryAt: text("review_next_retry_at"),
    reviewLastError: text("review_last_error"),
  },
  (t) => [
    index("idx_life_reminder_attempts_plan").on(
      t.planId,
      t.ownerType,
      t.ownerId,
    ),
    index("idx_life_reminder_attempts_review_scan").on(
      t.agentId,
      t.outcome,
      t.reviewStatus,
      t.reviewAt,
    ),
  ],
);

export const lifeEscalationStates = remindersSchema.table(
  "life_escalation_states",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    reason: text("reason").notNull().default(""),
    text: text("text").notNull().default(""),
    currentStep: integer("current_step").notNull().default(0),
    channelsSentJson: text("channels_sent_json").notNull().default("[]"),
    startedAt: text("started_at").notNull(),
    lastSentAt: text("last_sent_at").notNull(),
    resolved: boolean("resolved").notNull().default(false),
    resolvedAt: text("resolved_at"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("idx_life_escalation_states_agent_resolved").on(
      t.agentId,
      t.resolved,
    ),
  ],
);

export const remindersDbSchema = {
  lifeReminderPlans,
  lifeReminderAttempts,
  lifeEscalationStates,
} as const;

export type ReminderPlanRow = typeof lifeReminderPlans.$inferSelect;
export type ReminderAttemptRow = typeof lifeReminderAttempts.$inferSelect;
export type EscalationStateRow = typeof lifeEscalationStates.$inferSelect;
