/**
 * Drizzle schema for the scheduling-owned ScheduledTask store.
 *
 * The table and column names intentionally match their original
 * `app_lifeops` definitions so the carve-out migration can copy rows into the
 * plugin-owned `app_scheduling` namespace without data reshaping.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const appSchedulingPgSchema = pgSchema("app_scheduling");

export const lifeScheduledTasks = appSchedulingPgSchema.table(
  "life_scheduled_tasks",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    kind: text("kind").notNull(),
    promptInstructions: text("prompt_instructions").notNull(),
    contextRequestJson: text("context_request_json"),
    triggerJson: text("trigger_json").notNull(),
    priority: text("priority").notNull().default("medium"),
    shouldFireJson: text("should_fire_json"),
    completionCheckJson: text("completion_check_json"),
    escalationJson: text("escalation_json"),
    outputJson: text("output_json"),
    pipelineJson: text("pipeline_json"),
    subjectKind: text("subject_kind"),
    subjectId: text("subject_id"),
    idempotencyKey: text("idempotency_key"),
    respectsGlobalPause: boolean("respects_global_pause")
      .notNull()
      .default(true),
    stateJson: text("state_json").notNull().default("{}"),
    source: text("source").notNull().default("user_chat"),
    createdBy: text("created_by").notNull().default(""),
    ownerVisible: boolean("owner_visible").notNull().default(true),
    metadataJson: text("metadata_json").notNull().default("{}"),
    executionProfile: text("execution_profile"),
    transferToken: text("transfer_token"),
    transferTargetAgentId: text("transfer_target_agent_id"),
    transferStatus: text("transfer_status"),
    version: integer("version").notNull().default(1),
    nextFireAt: timestamp("next_fire_at", { withTimezone: true }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    unique().on(t.agentId, t.idempotencyKey),
    index("idx_scheduling_tasks_agent_kind").on(t.agentId, t.kind),
    index("idx_scheduling_tasks_subject").on(
      t.agentId,
      t.subjectKind,
      t.subjectId,
    ),
    index("idx_scheduling_tasks_due")
      .on(t.agentId, t.nextFireAt)
      .where(
        sql`(state_json::jsonb ->> 'status') IN ('scheduled', 'fired', 'acknowledged', 'completed', 'skipped', 'expired', 'failed')`,
      ),
  ],
);

export const lifeScheduledTaskLog = appSchedulingPgSchema.table(
  "life_scheduled_task_log",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    taskId: text("task_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    transition: text("transition").notNull(),
    reason: text("reason"),
    rolledUp: boolean("rolled_up").notNull().default(false),
    detailJson: text("detail_json"),
  },
  (t) => [
    index("idx_scheduling_task_log_agent_task").on(t.agentId, t.taskId),
    index("idx_scheduling_task_log_agent_time").on(t.agentId, t.occurredAt),
  ],
);

export const schedulingDbSchema = {
  lifeScheduledTasks,
  lifeScheduledTaskLog,
} as const;
