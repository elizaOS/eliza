-- Makes recovery a durable bounded shard phase instead of a repeated top-N probe.
ALTER TABLE "agent_backup_admission_claim_shards"
  ADD COLUMN IF NOT EXISTS "recovery_start_turn" bigint,
  ADD COLUMN IF NOT EXISTS "recovery_cutoff_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "recovery_cursor_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "recovery_cursor_state" smallint,
  ADD COLUMN IF NOT EXISTS "recovery_cursor_id" uuid,
  ADD COLUMN IF NOT EXISTS "last_recovery_claim_cycle_start_turn" bigint;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_backup_admission_claim_shards_recovery_shape_check' AND conrelid = 'agent_backup_admission_claim_shards'::regclass) THEN
    ALTER TABLE "agent_backup_admission_claim_shards" ADD CONSTRAINT "agent_backup_admission_claim_shards_recovery_shape_check" CHECK ((
      ("last_recovery_claim_cycle_start_turn" IS NULL OR ("last_recovery_claim_cycle_start_turn" > 0 AND "last_recovery_claim_cycle_start_turn" <= "last_turn")) AND
      (("recovery_start_turn" IS NULL AND "recovery_cutoff_at" IS NULL AND "recovery_cursor_at" IS NULL AND "recovery_cursor_state" IS NULL AND "recovery_cursor_id" IS NULL) OR
       ("recovery_start_turn" > 0 AND "recovery_start_turn" <= "last_turn" AND "recovery_cutoff_at" IS NOT NULL AND
        (("recovery_cursor_at" IS NULL AND "recovery_cursor_state" IS NULL AND "recovery_cursor_id" IS NULL) OR
         ("recovery_cursor_at" IS NOT NULL AND "recovery_cursor_at" <= "recovery_cutoff_at" AND "recovery_cursor_state" BETWEEN 0 AND 1 AND "recovery_cursor_id" IS NOT NULL))))
    ) IS TRUE);
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "agent_backup_admission_recovery_work_remains"(p_work_kind text, p_shard_id smallint, p_cutoff_at timestamptz, p_cursor_at timestamptz, p_cursor_state smallint, p_cursor_id uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF p_cursor_at IS NULL THEN
    RETURN EXISTS (SELECT 1 FROM "agent_backup_admission_work" work WHERE work."work_kind" = p_work_kind AND work."shard_id" = p_shard_id AND work."state" = 'deferred' AND work."not_before" <= p_cutoff_at) OR EXISTS (SELECT 1 FROM "agent_backup_admission_work" work WHERE work."work_kind" = p_work_kind AND work."shard_id" = p_shard_id AND work."state" = 'leased' AND work."lease_expires_at" <= p_cutoff_at);
  ELSIF p_cursor_state = 0 THEN
    RETURN EXISTS (SELECT 1 FROM "agent_backup_admission_work" work WHERE work."work_kind" = p_work_kind AND work."shard_id" = p_shard_id AND work."state" = 'deferred' AND (work."not_before", work."id") > (p_cursor_at, p_cursor_id) AND work."not_before" <= p_cutoff_at) OR EXISTS (SELECT 1 FROM "agent_backup_admission_work" work WHERE work."work_kind" = p_work_kind AND work."shard_id" = p_shard_id AND work."state" = 'leased' AND work."lease_expires_at" >= p_cursor_at AND work."lease_expires_at" <= p_cutoff_at);
  ELSE
    RETURN EXISTS (SELECT 1 FROM "agent_backup_admission_work" work WHERE work."work_kind" = p_work_kind AND work."shard_id" = p_shard_id AND work."state" = 'deferred' AND work."not_before" > p_cursor_at AND work."not_before" <= p_cutoff_at) OR EXISTS (SELECT 1 FROM "agent_backup_admission_work" work WHERE work."work_kind" = p_work_kind AND work."shard_id" = p_shard_id AND work."state" = 'leased' AND (work."lease_expires_at", work."id") > (p_cursor_at, p_cursor_id) AND work."lease_expires_at" <= p_cutoff_at);
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_claim_shard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_active boolean := OLD."cycle_observed_at" IS NOT NULL; new_active boolean := NEW."cycle_observed_at" IS NOT NULL; old_recovery boolean := OLD."recovery_cutoff_at" IS NOT NULL; new_recovery boolean := NEW."recovery_cutoff_at" IS NOT NULL;
  first_pass smallint := 0; final_pass smallint := CASE NEW."work_kind" WHEN 'schedule_capture' THEN 3 WHEN 'catalog_operation' THEN 5 ELSE 6 END;
  old_at_high_water boolean := OLD."scan_cursor_id" IS NOT NULL AND (OLD."scan_cursor_cohort", OLD."scan_cursor_ordinal", OLD."scan_cursor_id") = (OLD."cycle_max_cohort", OLD."cycle_max_ordinal", OLD."cycle_max_id"); restarting_after_admission boolean := false;
  recovery_changed boolean := ROW(NEW."recovery_start_turn", NEW."recovery_cutoff_at", NEW."recovery_cursor_at", NEW."recovery_cursor_state", NEW."recovery_cursor_id", NEW."last_recovery_claim_cycle_start_turn") IS DISTINCT FROM ROW(OLD."recovery_start_turn", OLD."recovery_cutoff_at", OLD."recovery_cursor_at", OLD."recovery_cursor_state", OLD."recovery_cursor_id", OLD."last_recovery_claim_cycle_start_turn");
  claim_changed boolean := ROW(NEW."cycle_start_turn", NEW."cycle_observed_at", NEW."cycle_max_cohort", NEW."cycle_max_ordinal", NEW."cycle_max_id", NEW."cycle_aging_interval_ms", NEW."priority_pass", NEW."scan_cursor_cohort", NEW."scan_cursor_ordinal", NEW."scan_cursor_id", NEW."last_admitted_work_id", NEW."last_admission_proof_turn") IS DISTINCT FROM ROW(OLD."cycle_start_turn", OLD."cycle_observed_at", OLD."cycle_max_cohort", OLD."cycle_max_ordinal", OLD."cycle_max_id", OLD."cycle_aging_interval_ms", OLD."priority_pass", OLD."scan_cursor_cohort", OLD."scan_cursor_ordinal", OLD."scan_cursor_id", OLD."last_admitted_work_id", OLD."last_admission_proof_turn");
BEGIN
  IF NEW."work_kind" IS DISTINCT FROM OLD."work_kind" OR NEW."shard_id" IS DISTINCT FROM OLD."shard_id" THEN RAISE EXCEPTION 'backup admission claim shard identity is immutable' USING ERRCODE = '55000'; END IF;
  IF NEW."last_turn" <= OLD."last_turn" THEN RAISE EXCEPTION 'backup admission claim shard turn must advance' USING ERRCODE = '55000'; END IF;
  IF recovery_changed THEN
    IF claim_changed THEN RAISE EXCEPTION 'backup admission recovery cannot mutate claim-cycle authority' USING ERRCODE = '55000'; END IF;
    IF NOT old_recovery AND new_recovery THEN
      IF NEW."recovery_start_turn" IS NOT NULL OR NEW."recovery_cursor_at" IS NOT NULL OR NEW."recovery_cursor_state" IS NOT NULL OR NEW."recovery_cursor_id" IS NOT NULL OR NEW."last_recovery_claim_cycle_start_turn" IS DISTINCT FROM OLD."last_recovery_claim_cycle_start_turn" THEN RAISE EXCEPTION 'backup admission recovery must start with an empty cursor' USING ERRCODE = '55000'; END IF;
      IF old_active AND (OLD."cycle_start_turn" IS NULL OR OLD."last_recovery_claim_cycle_start_turn" IS NOT DISTINCT FROM OLD."cycle_start_turn") THEN RAISE EXCEPTION 'backup admission recovery already swept this claim cycle' USING ERRCODE = '55000'; END IF;
      IF NOT old_active AND EXISTS (SELECT 1 FROM "agent_backup_admission_work" work WHERE work."work_kind" = OLD."work_kind" AND work."shard_id" = OLD."shard_id" AND work."state" = 'queued') THEN RAISE EXCEPTION 'backup admission recovery cannot displace an idle queued cycle' USING ERRCODE = '55000'; END IF;
      IF NOT EXISTS (SELECT 1 FROM "agent_backup_admission_work" work WHERE work."work_kind" = OLD."work_kind" AND work."shard_id" = OLD."shard_id" AND work."state" = 'deferred' AND work."not_before" <= statement_timestamp()) AND NOT EXISTS (SELECT 1 FROM "agent_backup_admission_work" work WHERE work."work_kind" = OLD."work_kind" AND work."shard_id" = OLD."shard_id" AND work."state" = 'leased' AND work."lease_expires_at" <= statement_timestamp()) THEN RAISE EXCEPTION 'backup admission recovery requires ready work' USING ERRCODE = '55000'; END IF;
      NEW."recovery_start_turn" := NEW."last_turn"; NEW."recovery_cutoff_at" := statement_timestamp();
    ELSIF old_recovery AND new_recovery THEN
      IF NEW."recovery_start_turn" IS DISTINCT FROM OLD."recovery_start_turn" OR NEW."recovery_cutoff_at" IS DISTINCT FROM OLD."recovery_cutoff_at" OR NEW."last_recovery_claim_cycle_start_turn" IS DISTINCT FROM OLD."last_recovery_claim_cycle_start_turn" OR NEW."recovery_cursor_at" IS NULL OR NEW."recovery_cursor_state" IS NULL OR NEW."recovery_cursor_id" IS NULL OR NEW."recovery_cursor_at" > OLD."recovery_cutoff_at" OR (OLD."recovery_cursor_at" IS NOT NULL AND (NEW."recovery_cursor_at", NEW."recovery_cursor_state", NEW."recovery_cursor_id") <= (OLD."recovery_cursor_at", OLD."recovery_cursor_state", OLD."recovery_cursor_id")) THEN RAISE EXCEPTION 'backup admission recovery cursor must advance exactly' USING ERRCODE = '55000'; END IF;
    ELSIF old_recovery AND NOT new_recovery THEN
      IF NEW."recovery_start_turn" IS NOT NULL OR NEW."recovery_cursor_at" IS NOT NULL OR NEW."recovery_cursor_state" IS NOT NULL OR NEW."recovery_cursor_id" IS NOT NULL OR NEW."last_recovery_claim_cycle_start_turn" IS DISTINCT FROM COALESCE(OLD."cycle_start_turn", OLD."last_recovery_claim_cycle_start_turn") THEN RAISE EXCEPTION 'backup admission recovery finish has an invalid authority shape' USING ERRCODE = '55000'; END IF;
      IF "agent_backup_admission_recovery_work_remains"(OLD."work_kind", OLD."shard_id", OLD."recovery_cutoff_at", OLD."recovery_cursor_at", OLD."recovery_cursor_state", OLD."recovery_cursor_id") THEN RAISE EXCEPTION 'backup admission recovery cannot finish before its frozen high-water' USING ERRCODE = '55000'; END IF;
    ELSE RAISE EXCEPTION 'backup admission recovery marker changes only on recovery finish' USING ERRCODE = '55000'; END IF;
    RETURN NEW;
  END IF;
  IF old_recovery OR new_recovery THEN RAISE EXCEPTION 'backup admission recovery must advance before claim-cycle authority' USING ERRCODE = '55000'; END IF;
  IF old_active AND new_active THEN
    IF ROW(NEW."cycle_observed_at", NEW."cycle_start_turn", NEW."cycle_max_cohort", NEW."cycle_max_ordinal", NEW."cycle_max_id") IS DISTINCT FROM ROW(OLD."cycle_observed_at", OLD."cycle_start_turn", OLD."cycle_max_cohort", OLD."cycle_max_ordinal", OLD."cycle_max_id") OR NEW."cycle_aging_interval_ms" IS DISTINCT FROM OLD."cycle_aging_interval_ms" THEN RAISE EXCEPTION 'backup admission claim cycle authority is immutable' USING ERRCODE = '55000'; END IF;
    restarting_after_admission := NEW."priority_pass" = first_pass AND NEW."scan_cursor_id" IS NULL AND (OLD."priority_pass" <> first_pass OR OLD."scan_cursor_id" IS NOT NULL) AND NEW."last_admitted_work_id" IS NOT NULL AND NEW."last_admission_proof_turn" IS NOT NULL AND NEW."last_admission_proof_turn" IS DISTINCT FROM OLD."last_admission_proof_turn" AND EXISTS (SELECT 1 FROM "agent_backup_admission_work" admitted WHERE admitted."id" = NEW."last_admitted_work_id" AND admitted."work_kind" = NEW."work_kind" AND admitted."shard_id" = NEW."shard_id" AND admitted."state" = 'leased' AND admitted."lease_expires_at" > clock_timestamp() AND admitted."claim_cycle_start_turn" = OLD."cycle_start_turn" AND admitted."claim_proof_turn" = NEW."last_admission_proof_turn" AND admitted."claim_proof_turn" > OLD."last_turn" AND admitted."claim_proof_turn" < NEW."last_turn" AND admitted."claim_proof_xid" = pg_current_xact_id() AND admitted."claim_proof_priority_pass" = OLD."priority_pass" AND admitted."claim_proof_attempt" = admitted."attempts" AND (admitted."ready_cohort", admitted."cohort_ordinal", admitted."id") <= (NEW."cycle_max_cohort", NEW."cycle_max_ordinal", NEW."cycle_max_id"));
    IF ROW(NEW."last_admitted_work_id", NEW."last_admission_proof_turn") IS DISTINCT FROM ROW(OLD."last_admitted_work_id", OLD."last_admission_proof_turn") AND NOT restarting_after_admission THEN RAISE EXCEPTION 'backup admission claim restart requires an exact same-transaction admission proof' USING ERRCODE = '55000'; END IF;
    IF restarting_after_admission THEN NULL; ELSIF NEW."priority_pass" = OLD."priority_pass" THEN IF NEW."scan_cursor_id" IS NULL OR (OLD."scan_cursor_id" IS NOT NULL AND (NEW."scan_cursor_cohort", NEW."scan_cursor_ordinal", NEW."scan_cursor_id") <= (OLD."scan_cursor_cohort", OLD."scan_cursor_ordinal", OLD."scan_cursor_id")) THEN RAISE EXCEPTION 'backup admission claim cursor must advance' USING ERRCODE = '55000'; END IF; ELSIF NEW."priority_pass" = OLD."priority_pass" + 1 THEN IF NOT old_at_high_water OR NEW."scan_cursor_id" IS NOT NULL THEN RAISE EXCEPTION 'backup admission claim pass must reset its cursor after reaching high-water' USING ERRCODE = '55000'; END IF; ELSE RAISE EXCEPTION 'backup admission claim priority pass must advance once' USING ERRCODE = '55000'; END IF;
  ELSIF NOT old_active AND new_active THEN
    IF NEW."priority_pass" <> first_pass OR NEW."scan_cursor_id" IS NOT NULL OR NEW."cycle_start_turn" IS NOT NULL OR NEW."last_admitted_work_id" IS NOT NULL OR NEW."last_admission_proof_turn" IS NOT NULL THEN RAISE EXCEPTION 'backup admission claim cycle must start at its first pass' USING ERRCODE = '55000'; END IF;
    NEW."cycle_observed_at" := statement_timestamp(); NEW."cycle_start_turn" := NEW."last_turn";
  ELSIF old_active AND NOT new_active AND (OLD."priority_pass" <> final_pass OR NOT old_at_high_water) THEN RAISE EXCEPTION 'backup admission claim cycle cannot finish before its final pass and high-water' USING ERRCODE = '55000';
  ELSIF old_active AND NOT new_active THEN NEW."cycle_start_turn" := NULL; NEW."last_admitted_work_id" := NULL; NEW."last_admission_proof_turn" := NULL; END IF;
  RETURN NEW;
END $$;
