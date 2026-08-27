-- Preserves the seeded shard identities and fences every progress mutation.

CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_shard_update"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  progress_changed boolean := ROW(
    NEW."scan_cutoff_at", NEW."scan_snapshot"::text, NEW."scan_cursor_due_at",
    NEW."scan_cursor_id", NEW."scan_cursor_ordinal", NEW."scan_schedule_rpo_ms",
    NEW."active_cohort"
  ) IS DISTINCT FROM ROW(
    OLD."scan_cutoff_at", OLD."scan_snapshot"::text, OLD."scan_cursor_due_at",
    OLD."scan_cursor_id", OLD."scan_cursor_ordinal", OLD."scan_schedule_rpo_ms",
    OLD."active_cohort"
  );
  old_lease_live boolean := OLD."lease_owner" IS NOT NULL
    AND OLD."lease_generation" IS NOT NULL
    AND OLD."lease_expires_at" > clock_timestamp();
BEGIN
  IF NEW."work_kind" IS DISTINCT FROM OLD."work_kind"
    OR NEW."shard_id" IS DISTINCT FROM OLD."shard_id" THEN
    RAISE EXCEPTION 'backup admission shard identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF old_lease_live AND NEW."lease_owner" IS NOT NULL AND (
    NEW."lease_owner" IS DISTINCT FROM OLD."lease_owner"
    OR NEW."lease_generation" IS DISTINCT FROM OLD."lease_generation"
    OR NEW."lease_expires_at" < OLD."lease_expires_at"
  ) THEN
    RAISE EXCEPTION 'backup admission shard live lease cannot be replaced'
      USING ERRCODE = '55000';
  END IF;
  IF NOT old_lease_live AND NEW."lease_owner" IS NOT NULL
    AND NEW."lease_expires_at" <= clock_timestamp() THEN
    RAISE EXCEPTION 'backup admission shard acquisition requires a live lease'
      USING ERRCODE = '55000';
  END IF;
  IF old_lease_live AND NEW."lease_owner" IS NULL AND NOT progress_changed THEN
    RAISE EXCEPTION 'backup admission shard lease release must commit progress'
      USING ERRCODE = '55000';
  END IF;
  IF progress_changed AND NOT (
    (NOT old_lease_live
      AND OLD."active_cohort" IS NULL AND NEW."active_cohort" IS NOT NULL
      AND NEW."scan_cursor_due_at" IS NULL AND NEW."scan_cursor_id" IS NULL
      AND NEW."scan_cursor_ordinal" IS NULL AND NEW."lease_owner" IS NOT NULL
      AND NEW."lease_generation" IS NOT NULL
      AND NEW."lease_expires_at" > clock_timestamp())
    OR (old_lease_live AND NEW."lease_owner" IS NULL
      AND NEW."active_cohort" IS NULL)
    OR (old_lease_live AND NEW."lease_owner" IS NULL
      AND NEW."active_cohort" = OLD."active_cohort"
      AND NEW."scan_cutoff_at" = OLD."scan_cutoff_at"
      AND NEW."scan_snapshot"::text = OLD."scan_snapshot"::text
      AND NEW."scan_schedule_rpo_ms" IS NOT DISTINCT FROM OLD."scan_schedule_rpo_ms"
      AND NEW."scan_cursor_due_at" IS NOT NULL AND NEW."scan_cursor_id" IS NOT NULL
      AND NEW."scan_cursor_ordinal" > COALESCE(OLD."scan_cursor_ordinal", -1)
      AND (OLD."scan_cursor_due_at" IS NULL OR
        (NEW."scan_cursor_due_at", NEW."scan_cursor_id") >
        (OLD."scan_cursor_due_at", OLD."scan_cursor_id")))
  ) THEN
    RAISE EXCEPTION 'backup admission shard progress requires an unexpired lease'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_shard_removal"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'backup admission shard authorities cannot be removed'
    USING ERRCODE = '55000';
END
$$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE
    tgname = 'agent_backup_admission_shard_update_guard'
    AND tgrelid = 'agent_backup_admission_enrollment_shards'::regclass) THEN
    CREATE TRIGGER "agent_backup_admission_shard_update_guard"
      BEFORE UPDATE ON "agent_backup_admission_enrollment_shards" FOR EACH ROW
      EXECUTE FUNCTION "guard_agent_backup_admission_shard_update"();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE
    tgname = 'agent_backup_admission_shard_delete_guard'
    AND tgrelid = 'agent_backup_admission_enrollment_shards'::regclass) THEN
    CREATE TRIGGER "agent_backup_admission_shard_delete_guard"
      BEFORE DELETE ON "agent_backup_admission_enrollment_shards" FOR EACH ROW
      EXECUTE FUNCTION "guard_agent_backup_admission_shard_removal"();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE
    tgname = 'agent_backup_admission_shard_truncate_guard'
    AND tgrelid = 'agent_backup_admission_enrollment_shards'::regclass) THEN
    CREATE TRIGGER "agent_backup_admission_shard_truncate_guard"
      BEFORE TRUNCATE ON "agent_backup_admission_enrollment_shards" FOR EACH STATEMENT
      EXECUTE FUNCTION "guard_agent_backup_admission_shard_removal"();
  END IF;
END $$;
