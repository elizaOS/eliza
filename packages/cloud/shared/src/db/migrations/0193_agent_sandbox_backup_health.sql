CREATE TABLE IF NOT EXISTS "agent_sandbox_backup_health" (
  "sandbox_record_id" uuid PRIMARY KEY NOT NULL,
  "image_identity" text,
  "capability" text DEFAULT 'unknown' NOT NULL,
  "last_attempt_started_at" timestamp with time zone,
  "last_attempt_completed_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "last_outcome" text,
  "attempt_token" uuid,
  "attempt_job_id" uuid,
  "attempt_job_started_at" timestamp,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "backup_required" boolean DEFAULT false NOT NULL,
  "next_attempt_at" timestamp with time zone,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_error" varchar(1024),
  "alert_fingerprint" text,
  "last_alerted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_sandbox_backup_health_sandbox_record_id_agent_sandboxes_id_fk"
    FOREIGN KEY ("sandbox_record_id")
    REFERENCES "public"."agent_sandboxes"("id")
    ON DELETE cascade,
  CONSTRAINT "agent_sandbox_backup_health_capability_check"
    CHECK ("capability" IN ('unknown', 'supported', 'unsupported')),
  CONSTRAINT "agent_sandbox_backup_health_outcome_check"
    CHECK (
      "last_outcome" IS NULL
      OR "last_outcome" IN (
        'in_progress',
        'success',
        'unsupported',
        'unavailable',
        'failed',
        'enqueue_failed',
        'image_changed',
        'generation_changed'
      )
    ),
  CONSTRAINT "agent_sandbox_backup_health_attempt_pair_check"
    CHECK (
      (
        "attempt_token" IS NULL
        AND "attempt_job_id" IS NULL
        AND "attempt_job_started_at" IS NULL
      )
      OR (
        "attempt_token" IS NOT NULL
        AND "attempt_job_id" IS NOT NULL
        AND "attempt_job_started_at" IS NOT NULL
      )
    ),
  CONSTRAINT "agent_sandbox_backup_health_lease_pair_check"
    CHECK (
      (
        "lease_token" IS NULL
        AND "lease_expires_at" IS NULL
      )
      OR (
        "lease_token" IS NOT NULL
        AND "lease_expires_at" IS NOT NULL
      )
    ),
  CONSTRAINT "agent_sandbox_backup_health_failures_nonnegative_check"
    CHECK ("consecutive_failures" >= 0),
  CONSTRAINT "agent_sandbox_backup_health_unsupported_identity_check"
    CHECK ("capability" <> 'unsupported' OR "image_identity" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "agent_backup_fleet_health_state" (
  "scope" varchar(64) PRIMARY KEY NOT NULL,
  "alert_fingerprint" text,
  "last_alerted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "agent_sandbox_backup_health_due_idx"
  ON "agent_sandbox_backup_health" ("next_attempt_at", "last_attempt_started_at");
CREATE INDEX IF NOT EXISTS "agent_sandbox_backup_health_lease_idx"
  ON "agent_sandbox_backup_health" ("lease_expires_at");
CREATE INDEX IF NOT EXISTS "agent_sandbox_backup_health_capability_idx"
  ON "agent_sandbox_backup_health" ("capability");
