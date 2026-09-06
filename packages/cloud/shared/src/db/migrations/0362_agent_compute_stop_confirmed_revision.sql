ALTER TABLE "agent_compute_stop_intents"
  ADD COLUMN IF NOT EXISTS "provider_confirmed_lifecycle_revision" bigint;
--> statement-breakpoint
ALTER TABLE "agent_compute_stop_intents"
  ADD COLUMN IF NOT EXISTS "resume_job_id" uuid REFERENCES "jobs"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "resume_started_at" timestamptz;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_compute_stop_intents'::regclass
      AND conname = 'agent_compute_stop_intents_confirmed_revision_check'
  ) THEN
    ALTER TABLE "agent_compute_stop_intents"
      ADD CONSTRAINT "agent_compute_stop_intents_confirmed_revision_check"
      CHECK (provider_confirmed_lifecycle_revision IS NULL OR (
        provider_confirmed_lifecycle_revision >= 0
        AND provider_confirmed_at IS NOT NULL
        AND status IN ('provider_confirmed', 'superseded')
      ));
  END IF;
END $$;
