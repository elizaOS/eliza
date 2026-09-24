-- Existing stop intents may retain a legacy full backup without adopting v2 catalog metadata.
ALTER TABLE "agent_compute_stop_intents"
  ADD COLUMN IF NOT EXISTS "prepared_backup" jsonb;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_compute_stop_intents_prepared_backup_object' AND conrelid = 'agent_compute_stop_intents'::regclass) THEN
    ALTER TABLE "agent_compute_stop_intents"
      ADD CONSTRAINT "agent_compute_stop_intents_prepared_backup_object"
      CHECK ("prepared_backup" IS NULL OR jsonb_typeof("prepared_backup") = 'object');
  END IF;
END $$;
