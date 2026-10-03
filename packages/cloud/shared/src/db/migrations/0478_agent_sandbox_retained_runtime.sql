-- An unpaid stop whose current backup cannot be captured retains the exact
-- stopped container in place instead of removing the only copy of its state.
ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "retained_runtime" jsonb;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_sandboxes_retained_runtime_object' AND conrelid = 'agent_sandboxes'::regclass) THEN
    ALTER TABLE "agent_sandboxes"
      ADD CONSTRAINT "agent_sandboxes_retained_runtime_object"
      CHECK ("retained_runtime" IS NULL OR jsonb_typeof("retained_runtime") = 'object');
  END IF;
END $$;
