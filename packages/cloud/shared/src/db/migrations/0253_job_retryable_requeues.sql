-- Adds database-owned retry accounting for attempt-preserving job requeues.

ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "retryable_requeues" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jobs_retryable_requeues_nonnegative_check'
      AND conrelid = 'jobs'::regclass
  ) THEN
    ALTER TABLE "jobs" ADD CONSTRAINT
      "jobs_retryable_requeues_nonnegative_check"
      CHECK ("retryable_requeues" >= 0) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "jobs"
  VALIDATE CONSTRAINT "jobs_retryable_requeues_nonnegative_check";
