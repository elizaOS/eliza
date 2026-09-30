-- #22967: frozen/sleeping retention economics (owner decision, see #22957).
-- When funding stops (a provider-confirmed billing stop after credits run out,
-- or a Plus/Pro plan withdrawn past its grace period), the agent's container
-- state is retained for 30 days at no charge. Deletion notices go out 7 days
-- and 1 day before the deadline. At the deadline the container is removed
-- through the existing sleep lifecycle (durable backup, then container
-- removal) and the latest backup is pinned for 90 more days. Paying before the
-- deadline resumes the same agent through the existing resume paths; this
-- table only tracks the retention clock, its notices and its effects.
CREATE TABLE IF NOT EXISTS "agent_funding_retentions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "stop_intent_id" uuid,
  "fallback_id" uuid,
  "state" text DEFAULT 'retained' NOT NULL,
  "suspended_at" timestamp with time zone NOT NULL,
  "delete_after" timestamp with time zone NOT NULL,
  "notice_7d_sent_at" timestamp with time zone,
  "notice_1d_sent_at" timestamp with time zone,
  "sleep_job_id" uuid,
  "container_deleted_at" timestamp with time zone,
  "retained_backup_id" uuid,
  "backup_retain_until" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "closed_reason" text,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_funding_retentions_reason_check"
    CHECK (("reason" = 'credits_exhausted' AND "stop_intent_id" IS NOT NULL AND "fallback_id" IS NULL)
      OR ("reason" = 'subscription_lapsed' AND "fallback_id" IS NOT NULL AND "stop_intent_id" IS NULL)),
  CONSTRAINT "agent_funding_retentions_state_check"
    CHECK (("state" = 'retained' AND "container_deleted_at" IS NULL AND "closed_at" IS NULL)
      OR ("state" = 'container_deletion_pending' AND "sleep_job_id" IS NOT NULL
        AND "container_deleted_at" IS NULL AND "closed_at" IS NULL)
      OR ("state" = 'container_deleted' AND "container_deleted_at" IS NOT NULL
        AND "backup_retain_until" IS NOT NULL AND "closed_at" IS NULL)
      OR ("state" = 'closed' AND "container_deleted_at" IS NULL AND "closed_at" IS NOT NULL
        AND "closed_reason" IN ('funding_restored', 'agent_changed'))),
  CONSTRAINT "agent_funding_retentions_window_check"
    CHECK ("delete_after" > "suspended_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_funding_retentions_open_agent_unique"
  ON "agent_funding_retentions" ("organization_id", "agent_id")
  WHERE "state" IN ('retained', 'container_deletion_pending');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_funding_retentions_stop_intent_unique"
  ON "agent_funding_retentions" ("stop_intent_id")
  WHERE "stop_intent_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_funding_retentions_fallback_unique"
  ON "agent_funding_retentions" ("fallback_id")
  WHERE "fallback_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_funding_retentions_due_idx"
  ON "agent_funding_retentions" ("state", "delete_after")
  WHERE "state" IN ('retained', 'container_deletion_pending');
