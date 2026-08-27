-- Fences claims and permits only explicit restartable state transitions.

CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_work_state"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT (
    (OLD."state" = 'queued' AND NEW."state" IN ('queued', 'deferred', 'leased', 'settled'))
    OR (OLD."state" = 'deferred' AND NEW."state" IN ('deferred', 'queued', 'settled'))
    OR (OLD."state" = 'leased' AND NEW."state" IN ('leased', 'deferred', 'queued', 'settled'))
    OR (OLD."state" = 'settled' AND NEW."state" = 'settled')
  ) THEN
    RAISE EXCEPTION 'invalid backup admission state transition: % -> %',
      OLD."state", NEW."state" USING ERRCODE = '55000';
  END IF;
  IF OLD."state" = 'queued' AND NEW."state" = 'leased' THEN
    IF NEW."attempts" <> OLD."attempts" + 1 THEN
      RAISE EXCEPTION 'backup admission claim must increment attempts once'
        USING ERRCODE = '55000';
    END IF;
    IF NEW."lease_expires_at" IS NULL
      OR NEW."lease_expires_at" <= statement_timestamp() THEN
      RAISE EXCEPTION 'backup admission claim requires a live lease'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW."attempts" IS DISTINCT FROM OLD."attempts" THEN
    RAISE EXCEPTION 'backup admission attempts change only on claim'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."state" = 'leased' OR OLD."state" = NEW."state" THEN
    IF NEW."not_before" IS DISTINCT FROM OLD."not_before" THEN
      RAISE EXCEPTION 'backup admission claim preserves readiness'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW."not_before" < OLD."not_before" THEN
    RAISE EXCEPTION 'backup admission readiness cannot move backward'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."state" IN ('deferred', 'leased') AND NEW."state" = 'queued' THEN
    IF NEW."ready_cohort" <= OLD."ready_cohort" THEN
      RAISE EXCEPTION 'backup admission requeue requires a newer cohort'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD."ready_cohort" IS DISTINCT FROM NEW."ready_cohort"
    OR OLD."cohort_ordinal" IS DISTINCT FROM NEW."cohort_ordinal" THEN
    RAISE EXCEPTION 'backup admission cohort is immutable outside requeue'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."state" = 'leased' AND NEW."state" = 'leased' THEN
    IF OLD."lease_expires_at" IS NULL
      OR (
        OLD."lease_expires_at" <= statement_timestamp()
        AND OLD.xmin IS DISTINCT FROM pg_current_xact_id()::xid
      )
      OR NEW."lease_expires_at" IS NULL
      OR NEW."lease_expires_at" <= statement_timestamp() THEN
      RAISE EXCEPTION 'expired backup admission lease cannot be renewed'
        USING ERRCODE = '55000';
    END IF;
    IF OLD."lease_owner" IS DISTINCT FROM NEW."lease_owner"
      OR OLD."lease_generation" IS DISTINCT FROM NEW."lease_generation"
      OR NEW."lease_expires_at" < OLD."lease_expires_at" THEN
      RAISE EXCEPTION 'backup admission lease must preserve its fence and horizon'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE
    tgname = 'agent_backup_admission_work_20_state_guard'
    AND tgrelid = 'agent_backup_admission_work'::regclass) THEN
    CREATE TRIGGER "agent_backup_admission_work_20_state_guard"
      BEFORE UPDATE ON "agent_backup_admission_work" FOR EACH ROW
      EXECUTE FUNCTION "guard_agent_backup_admission_work_state"();
  END IF;
END $$;
