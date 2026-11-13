-- Preserve the complete provider state vocabulary without mapping unknown states.
ALTER TYPE "vertex_tuning_job_state" ADD VALUE IF NOT EXISTS 'JOB_STATE_UNSPECIFIED';
--> statement-breakpoint
ALTER TYPE "vertex_tuning_job_state" ADD VALUE IF NOT EXISTS 'JOB_STATE_QUEUED';
--> statement-breakpoint
ALTER TYPE "vertex_tuning_job_state" ADD VALUE IF NOT EXISTS 'JOB_STATE_CANCELLING';
--> statement-breakpoint
ALTER TYPE "vertex_tuning_job_state" ADD VALUE IF NOT EXISTS 'JOB_STATE_PAUSED';
--> statement-breakpoint
ALTER TYPE "vertex_tuning_job_state" ADD VALUE IF NOT EXISTS 'JOB_STATE_EXPIRED';
--> statement-breakpoint
ALTER TYPE "vertex_tuning_job_state" ADD VALUE IF NOT EXISTS 'JOB_STATE_UPDATING';
--> statement-breakpoint
ALTER TYPE "vertex_tuning_job_state" ADD VALUE IF NOT EXISTS 'JOB_STATE_PARTIALLY_SUCCEEDED';
--> statement-breakpoint
-- PostgreSQL timestamps retain microseconds; the provider emits nanoseconds.
-- Legacy rows must recover their exact version from their retained full payload.
ALTER TABLE "vertex_tuning_jobs"
  ADD COLUMN "provider_update_time" text,
  ADD COLUMN "provider_payload_digest" text,
  ADD COLUMN "completed_provider_time" text,
  ADD COLUMN "observation_revision" bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "vertex_tuning_jobs" ADD CONSTRAINT "vertex_tuning_jobs_observation_check" CHECK (
  observation_revision >= 0 AND (completed_provider_time IS NULL OR completed_provider_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{9}Z$') AND (
    (provider_update_time IS NULL AND provider_payload_digest IS NULL) OR
    (provider_update_time IS NOT NULL AND provider_payload_digest IS NOT NULL
      AND provider_update_time ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{9}Z$'
      AND provider_payload_digest ~ '^[0-9a-f]{64}$')
  )
);
