-- Lets a bounded raw-only page advance the global source watermark without
-- inventing a candidate ordinal. The composite source cursor must still move.

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
      AND NEW."scan_cursor_ordinal" >= COALESCE(OLD."scan_cursor_ordinal", -1)
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
