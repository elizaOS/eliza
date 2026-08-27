-- Prevents unfinished durable work from disappearing outside settlement.

CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_work_delete"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" <> 'settled' THEN
    RAISE EXCEPTION 'unsettled backup admission work cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE
    tgname = 'agent_backup_admission_work_delete_guard'
    AND tgrelid = 'agent_backup_admission_work'::regclass) THEN
    CREATE TRIGGER "agent_backup_admission_work_delete_guard"
      BEFORE DELETE ON "agent_backup_admission_work" FOR EACH ROW
      EXECUTE FUNCTION "guard_agent_backup_admission_work_delete"();
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_work_truncate"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'backup admission work cannot be truncated'
    USING ERRCODE = '55000';
END
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE
    tgname = 'agent_backup_admission_work_truncate_guard'
    AND tgrelid = 'agent_backup_admission_work'::regclass) THEN
    CREATE TRIGGER "agent_backup_admission_work_truncate_guard"
      BEFORE TRUNCATE ON "agent_backup_admission_work" FOR EACH STATEMENT
      EXECUTE FUNCTION "guard_agent_backup_admission_work_truncate"();
  END IF;
END $$;
