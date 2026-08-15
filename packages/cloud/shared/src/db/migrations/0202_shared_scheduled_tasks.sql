-- Persists free Shared reminders in the control-plane Postgres reached through
-- Hyperdrive. The scheduling plugin remains the sole state-machine owner;
-- this migration makes its canonical SQL store available to Worker cron.

CREATE SCHEMA IF NOT EXISTS "app_scheduling";

CREATE TABLE IF NOT EXISTS "app_scheduling"."life_scheduled_tasks" (
  "id" text NOT NULL,
  "agent_id" text NOT NULL,
  "kind" text NOT NULL,
  "prompt_instructions" text NOT NULL,
  "context_request_json" text,
  "trigger_json" text NOT NULL,
  "priority" text DEFAULT 'medium' NOT NULL,
  "should_fire_json" text,
  "completion_check_json" text,
  "escalation_json" text,
  "output_json" text,
  "pipeline_json" text,
  "subject_kind" text,
  "subject_id" text,
  "idempotency_key" text,
  "respects_global_pause" boolean DEFAULT true NOT NULL,
  "state_json" text DEFAULT '{}' NOT NULL,
  "source" text DEFAULT 'user_chat' NOT NULL,
  "created_by" text DEFAULT '' NOT NULL,
  "owner_visible" boolean DEFAULT true NOT NULL,
  "metadata_json" text DEFAULT '{}' NOT NULL,
  "execution_profile" text,
  "transfer_token" text,
  "transfer_holder_token" text,
  "transfer_target_agent_id" text,
  "transfer_status" text,
  "version" integer DEFAULT 1 NOT NULL,
  "next_fire_at" timestamp with time zone,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  PRIMARY KEY ("agent_id", "id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "idx_scheduling_tasks_agent_idempotency"
  ON "app_scheduling"."life_scheduled_tasks" ("agent_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "idx_scheduling_tasks_agent_kind"
  ON "app_scheduling"."life_scheduled_tasks" ("agent_id", "kind");
CREATE INDEX IF NOT EXISTS "idx_scheduling_tasks_subject"
  ON "app_scheduling"."life_scheduled_tasks" ("agent_id", "subject_kind", "subject_id");
CREATE INDEX IF NOT EXISTS "idx_scheduling_tasks_due"
  ON "app_scheduling"."life_scheduled_tasks" ("agent_id", "next_fire_at")
  WHERE ("state_json"::jsonb ->> 'status') IN (
    'scheduled', 'fired', 'acknowledged', 'completed', 'skipped', 'expired', 'failed'
  );
CREATE INDEX IF NOT EXISTS "idx_scheduling_tasks_global_due"
  ON "app_scheduling"."life_scheduled_tasks" ("next_fire_at", "agent_id", "id")
  WHERE "kind" = 'reminder'
    AND ("state_json"::jsonb ->> 'status') IN (
      'scheduled', 'fired', 'acknowledged', 'completed', 'skipped', 'expired', 'failed'
    );

CREATE INDEX IF NOT EXISTS "idx_scheduling_tasks_transfer"
  ON "app_scheduling"."life_scheduled_tasks" ("agent_id", "transfer_token")
  WHERE "transfer_status" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "app_scheduling"."life_scheduled_task_log" (
  "id" text PRIMARY KEY NOT NULL,
  "agent_id" text NOT NULL,
  "task_id" text NOT NULL,
  "occurred_at" text NOT NULL,
  "transition" text NOT NULL,
  "reason" text,
  "rolled_up" boolean DEFAULT false NOT NULL,
  "detail_json" text
);

CREATE INDEX IF NOT EXISTS "idx_scheduling_task_log_agent_task"
  ON "app_scheduling"."life_scheduled_task_log" ("agent_id", "task_id");
CREATE INDEX IF NOT EXISTS "idx_scheduling_task_log_agent_time"
  ON "app_scheduling"."life_scheduled_task_log" ("agent_id", "occurred_at");
