ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "execution_generation" uuid,
  ADD COLUMN IF NOT EXISTS "execution_quiesced_at" timestamp;

ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "lifecycle_job_id" uuid,
  ADD COLUMN IF NOT EXISTS "lifecycle_execution_generation" uuid;

CREATE INDEX IF NOT EXISTS "jobs_unquiesced_execution_idx"
  ON "jobs" ("organization_id", "agent_id", "type", "status")
  WHERE "execution_generation" IS NOT NULL
    AND "execution_quiesced_at" IS NULL
    AND "agent_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "agent_sandboxes_lifecycle_execution_idx"
  ON "agent_sandboxes" ("lifecycle_job_id", "lifecycle_execution_generation")
  WHERE "lifecycle_execution_generation" IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE "agent_sandboxes"
    ADD CONSTRAINT "agent_sandboxes_lifecycle_execution_pair_check"
    CHECK (
      (
        "lifecycle_job_id" IS NULL
        AND "lifecycle_execution_generation" IS NULL
      )
      OR (
        "lifecycle_job_id" IS NOT NULL
        AND "lifecycle_execution_generation" IS NOT NULL
      )
    );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
