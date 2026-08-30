-- Makes every claim turn monotonic and prevents shard authority removal.
CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_claim_shard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_active boolean := OLD."cycle_observed_at" IS NOT NULL;
  new_active boolean := NEW."cycle_observed_at" IS NOT NULL; first_pass smallint := 0;
  final_pass smallint := CASE NEW."work_kind"
    WHEN 'schedule_capture' THEN 3 WHEN 'catalog_operation' THEN 5 ELSE 6 END;
  old_at_high_water boolean := OLD."scan_cursor_id" IS NOT NULL AND (OLD."scan_cursor_cohort",
    OLD."scan_cursor_ordinal", OLD."scan_cursor_id") = (OLD."cycle_max_cohort", OLD."cycle_max_ordinal", OLD."cycle_max_id");
  restarting_after_admission boolean := false;
BEGIN
  IF NEW."work_kind" IS DISTINCT FROM OLD."work_kind" OR NEW."shard_id" IS DISTINCT FROM OLD."shard_id" THEN
    RAISE EXCEPTION 'backup admission claim shard identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW."last_turn" <= OLD."last_turn" THEN
    RAISE EXCEPTION 'backup admission claim shard turn must advance' USING ERRCODE = '55000';
  END IF;
  IF new_active AND ("agent_backup_admission_expected_shard"(NEW."cycle_max_id") <> NEW."shard_id"
    OR (NEW."scan_cursor_id" IS NOT NULL AND "agent_backup_admission_expected_shard"(NEW."scan_cursor_id") <> NEW."shard_id")) THEN
    RAISE EXCEPTION 'backup admission claim bounds must belong to their shard' USING ERRCODE = '55000';
  END IF;
  IF old_active AND new_active THEN
    IF ROW(NEW."cycle_observed_at", NEW."cycle_start_turn", NEW."cycle_max_cohort", NEW."cycle_max_ordinal", NEW."cycle_max_id")
      IS DISTINCT FROM ROW(OLD."cycle_observed_at", OLD."cycle_start_turn", OLD."cycle_max_cohort", OLD."cycle_max_ordinal", OLD."cycle_max_id")
      OR NEW."cycle_aging_interval_ms" IS DISTINCT FROM OLD."cycle_aging_interval_ms" THEN
      RAISE EXCEPTION 'backup admission claim cycle authority is immutable' USING ERRCODE = '55000';
    END IF;
    restarting_after_admission :=
      NEW."priority_pass" = first_pass
      AND NEW."scan_cursor_id" IS NULL
      AND (OLD."priority_pass" <> first_pass OR OLD."scan_cursor_id" IS NOT NULL)
      AND NEW."last_admitted_work_id" IS NOT NULL
      AND NEW."last_admission_proof_turn" IS NOT NULL
      AND NEW."last_admission_proof_turn" IS DISTINCT FROM OLD."last_admission_proof_turn"
      AND EXISTS (
        SELECT 1 FROM "agent_backup_admission_work" AS admitted
        WHERE admitted."id" = NEW."last_admitted_work_id"
          AND admitted."work_kind" = NEW."work_kind"
          AND admitted."shard_id" = NEW."shard_id"
          AND admitted."state" = 'leased' AND admitted."lease_expires_at" > clock_timestamp()
          AND admitted."claim_cycle_start_turn" = OLD."cycle_start_turn"
          AND admitted."claim_proof_turn" = NEW."last_admission_proof_turn"
          AND admitted."claim_proof_turn" > OLD."last_turn"
          AND admitted."claim_proof_turn" < NEW."last_turn"
          AND admitted."claim_proof_xid" = pg_current_xact_id()
          AND admitted."claim_proof_priority_pass" = OLD."priority_pass"
          AND admitted."claim_proof_attempt" = admitted."attempts"
          AND (admitted."ready_cohort", admitted."cohort_ordinal", admitted."id") <= (NEW."cycle_max_cohort", NEW."cycle_max_ordinal", NEW."cycle_max_id")
      );
    IF ROW(NEW."last_admitted_work_id", NEW."last_admission_proof_turn")
      IS DISTINCT FROM ROW(OLD."last_admitted_work_id", OLD."last_admission_proof_turn")
      AND NOT restarting_after_admission THEN
      RAISE EXCEPTION 'backup admission claim restart requires an exact same-transaction admission proof' USING ERRCODE = '55000';
    END IF;
    IF restarting_after_admission THEN
      NULL;
    ELSIF NEW."priority_pass" = OLD."priority_pass" THEN
      IF NEW."scan_cursor_id" IS NULL OR (OLD."scan_cursor_id" IS NOT NULL AND (NEW."scan_cursor_cohort",
        NEW."scan_cursor_ordinal", NEW."scan_cursor_id") <= (OLD."scan_cursor_cohort", OLD."scan_cursor_ordinal", OLD."scan_cursor_id")) THEN
        RAISE EXCEPTION 'backup admission claim cursor must advance' USING ERRCODE = '55000';
      END IF;
    ELSIF NEW."priority_pass" = OLD."priority_pass" + 1 THEN
      IF NOT old_at_high_water OR NEW."scan_cursor_id" IS NOT NULL THEN
        RAISE EXCEPTION 'backup admission claim pass must reset its cursor after reaching high-water' USING ERRCODE = '55000';
      END IF;
    ELSE
      RAISE EXCEPTION 'backup admission claim priority pass must advance once' USING ERRCODE = '55000';
    END IF;
  ELSIF NOT old_active AND new_active THEN
    IF NEW."priority_pass" <> first_pass OR NEW."scan_cursor_id" IS NOT NULL
      OR NEW."cycle_start_turn" IS NOT NULL OR NEW."last_admitted_work_id" IS NOT NULL
      OR NEW."last_admission_proof_turn" IS NOT NULL THEN
      RAISE EXCEPTION 'backup admission claim cycle must start at its first pass' USING ERRCODE = '55000';
    END IF;
    NEW."cycle_start_turn" := NEW."last_turn";
  ELSIF old_active AND NOT new_active AND (
    OLD."priority_pass" <> final_pass OR NOT old_at_high_water
  ) THEN
    RAISE EXCEPTION 'backup admission claim cycle cannot finish before its final pass and high-water' USING ERRCODE = '55000';
  ELSIF old_active AND NOT new_active THEN
    NEW."cycle_start_turn" := NULL; NEW."last_admitted_work_id" := NULL; NEW."last_admission_proof_turn" := NULL;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_backup_admission_claim_shard_update_guard'
    AND tgrelid = 'agent_backup_admission_claim_shards'::regclass) THEN
    CREATE TRIGGER "agent_backup_admission_claim_shard_update_guard" BEFORE UPDATE ON "agent_backup_admission_claim_shards" FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_admission_claim_shard_update"();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_backup_admission_claim_shard_delete_guard'
    AND tgrelid = 'agent_backup_admission_claim_shards'::regclass) THEN
    CREATE TRIGGER "agent_backup_admission_claim_shard_delete_guard" BEFORE DELETE ON "agent_backup_admission_claim_shards" FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_admission_shard_removal"();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_backup_admission_claim_shard_truncate_guard'
    AND tgrelid = 'agent_backup_admission_claim_shards'::regclass) THEN
    CREATE TRIGGER "agent_backup_admission_claim_shard_truncate_guard" BEFORE TRUNCATE ON "agent_backup_admission_claim_shards" FOR EACH STATEMENT EXECUTE FUNCTION "guard_agent_backup_admission_shard_removal"();
  END IF;
END $$;
