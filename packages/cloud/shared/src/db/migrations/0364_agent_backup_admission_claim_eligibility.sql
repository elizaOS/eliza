-- Separates opaque work-row bounds from source sharding and fences raw claims by DB-time eligibility.

CREATE OR REPLACE FUNCTION "agent_backup_admission_effective_priority"(
  base_priority smallint, first_eligible_at timestamp with time zone,
  cycle_observed_at timestamp with time zone, aging_interval_ms integer
) RETURNS smallint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT GREATEST(0, $1::integer - FLOOR(
    GREATEST(0::numeric, EXTRACT(EPOCH FROM ($3 - $2)) * 1000) / $4
  )::integer)::smallint
$$;
--> statement-breakpoint
ALTER TABLE "agent_backup_admission_claim_shards"
  DROP CONSTRAINT "agent_backup_admission_claim_shards_cycle_shape_check",
  ADD CONSTRAINT "agent_backup_admission_claim_shards_cycle_shape_check" CHECK ((
    ("cycle_observed_at" IS NULL AND "cycle_max_cohort" IS NULL
      AND "cycle_max_ordinal" IS NULL AND "cycle_max_id" IS NULL
      AND "cycle_aging_interval_ms" IS NULL AND "priority_pass" IS NULL
      AND "scan_cursor_cohort" IS NULL AND "scan_cursor_ordinal" IS NULL
      AND "scan_cursor_id" IS NULL AND "last_admitted_work_id" IS NULL)
    OR ("cycle_observed_at" IS NOT NULL AND "cycle_max_cohort" >= 0
      AND "cycle_max_ordinal" >= 0 AND "cycle_max_id" IS NOT NULL
      AND "cycle_aging_interval_ms" BETWEEN 60000 AND 86400000
      AND (("work_kind" = 'schedule_capture' AND "priority_pass" BETWEEN 0 AND 3)
        OR ("work_kind" = 'catalog_operation' AND "priority_pass" BETWEEN 0 AND 5)
        OR ("work_kind" = 'gc_object' AND "priority_pass" BETWEEN 0 AND 6))
      AND (("scan_cursor_cohort" IS NULL AND "scan_cursor_ordinal" IS NULL
          AND "scan_cursor_id" IS NULL)
        OR ("scan_cursor_cohort" BETWEEN 0 AND "cycle_max_cohort"
          AND "scan_cursor_ordinal" >= 0 AND "scan_cursor_id" IS NOT NULL
          AND ("scan_cursor_cohort", "scan_cursor_ordinal", "scan_cursor_id") <=
            ("cycle_max_cohort", "cycle_max_ordinal", "cycle_max_id"))))
  ) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_claim_shard_update"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_active boolean := OLD."cycle_observed_at" IS NOT NULL; new_active boolean := NEW."cycle_observed_at" IS NOT NULL;
  first_pass smallint := 0; final_pass smallint := CASE NEW."work_kind" WHEN 'schedule_capture' THEN 3 WHEN 'catalog_operation' THEN 5 ELSE 6 END;
  old_at_high_water boolean := OLD."scan_cursor_id" IS NOT NULL AND (OLD."scan_cursor_cohort", OLD."scan_cursor_ordinal", OLD."scan_cursor_id") = (OLD."cycle_max_cohort", OLD."cycle_max_ordinal", OLD."cycle_max_id");
  restarting_after_admission boolean := false;
BEGIN
  IF NEW."work_kind" IS DISTINCT FROM OLD."work_kind" OR NEW."shard_id" IS DISTINCT FROM OLD."shard_id" THEN RAISE EXCEPTION 'backup admission claim shard identity is immutable' USING ERRCODE = '55000'; END IF;
  IF NEW."last_turn" <= OLD."last_turn" THEN RAISE EXCEPTION 'backup admission claim shard turn must advance' USING ERRCODE = '55000'; END IF;
  IF old_active AND new_active THEN
    IF ROW(NEW."cycle_observed_at", NEW."cycle_start_turn", NEW."cycle_max_cohort", NEW."cycle_max_ordinal", NEW."cycle_max_id") IS DISTINCT FROM ROW(OLD."cycle_observed_at", OLD."cycle_start_turn", OLD."cycle_max_cohort", OLD."cycle_max_ordinal", OLD."cycle_max_id") OR NEW."cycle_aging_interval_ms" IS DISTINCT FROM OLD."cycle_aging_interval_ms" THEN RAISE EXCEPTION 'backup admission claim cycle authority is immutable' USING ERRCODE = '55000'; END IF;
    restarting_after_admission := NEW."priority_pass" = first_pass AND NEW."scan_cursor_id" IS NULL AND (OLD."priority_pass" <> first_pass OR OLD."scan_cursor_id" IS NOT NULL) AND NEW."last_admitted_work_id" IS NOT NULL AND NEW."last_admission_proof_turn" IS NOT NULL AND NEW."last_admission_proof_turn" IS DISTINCT FROM OLD."last_admission_proof_turn" AND EXISTS (
      SELECT 1 FROM "agent_backup_admission_work" admitted WHERE admitted."id" = NEW."last_admitted_work_id" AND admitted."work_kind" = NEW."work_kind" AND admitted."shard_id" = NEW."shard_id" AND admitted."state" = 'leased' AND admitted."lease_expires_at" > clock_timestamp() AND admitted."claim_cycle_start_turn" = OLD."cycle_start_turn" AND admitted."claim_proof_turn" = NEW."last_admission_proof_turn" AND admitted."claim_proof_turn" > OLD."last_turn" AND admitted."claim_proof_turn" < NEW."last_turn" AND admitted."claim_proof_xid" = pg_current_xact_id() AND admitted."claim_proof_priority_pass" = OLD."priority_pass" AND admitted."claim_proof_attempt" = admitted."attempts" AND (admitted."ready_cohort", admitted."cohort_ordinal", admitted."id") <= (NEW."cycle_max_cohort", NEW."cycle_max_ordinal", NEW."cycle_max_id"));
    IF ROW(NEW."last_admitted_work_id", NEW."last_admission_proof_turn") IS DISTINCT FROM ROW(OLD."last_admitted_work_id", OLD."last_admission_proof_turn") AND NOT restarting_after_admission THEN RAISE EXCEPTION 'backup admission claim restart requires an exact same-transaction admission proof' USING ERRCODE = '55000'; END IF;
    IF restarting_after_admission THEN NULL;
    ELSIF NEW."priority_pass" = OLD."priority_pass" THEN
      IF NEW."scan_cursor_id" IS NULL OR (OLD."scan_cursor_id" IS NOT NULL AND (NEW."scan_cursor_cohort", NEW."scan_cursor_ordinal", NEW."scan_cursor_id") <= (OLD."scan_cursor_cohort", OLD."scan_cursor_ordinal", OLD."scan_cursor_id")) THEN RAISE EXCEPTION 'backup admission claim cursor must advance' USING ERRCODE = '55000'; END IF;
    ELSIF NEW."priority_pass" = OLD."priority_pass" + 1 THEN
      IF NOT old_at_high_water OR NEW."scan_cursor_id" IS NOT NULL THEN RAISE EXCEPTION 'backup admission claim pass must reset its cursor after reaching high-water' USING ERRCODE = '55000'; END IF;
    ELSE RAISE EXCEPTION 'backup admission claim priority pass must advance once' USING ERRCODE = '55000'; END IF;
  ELSIF NOT old_active AND new_active THEN
    IF NEW."priority_pass" <> first_pass OR NEW."scan_cursor_id" IS NOT NULL OR NEW."cycle_start_turn" IS NOT NULL OR NEW."last_admitted_work_id" IS NOT NULL OR NEW."last_admission_proof_turn" IS NOT NULL THEN RAISE EXCEPTION 'backup admission claim cycle must start at its first pass' USING ERRCODE = '55000'; END IF;
    NEW."cycle_observed_at" := statement_timestamp(); NEW."cycle_start_turn" := NEW."last_turn";
  ELSIF old_active AND NOT new_active AND (OLD."priority_pass" <> final_pass OR NOT old_at_high_water) THEN RAISE EXCEPTION 'backup admission claim cycle cannot finish before its final pass and high-water' USING ERRCODE = '55000';
  ELSIF old_active AND NOT new_active THEN NEW."cycle_start_turn" := NULL; NEW."last_admitted_work_id" := NULL; NEW."last_admission_proof_turn" := NULL; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_work_state"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof_cycle_start_turn bigint; proof_priority_pass smallint; proof_observed_at timestamptz; proof_aging_interval_ms integer;
BEGIN
  IF NOT ((OLD."state" = 'queued' AND NEW."state" IN ('queued', 'deferred', 'leased', 'settled')) OR (OLD."state" = 'deferred' AND NEW."state" IN ('deferred', 'queued', 'settled')) OR (OLD."state" = 'leased' AND NEW."state" IN ('leased', 'deferred', 'queued', 'settled')) OR (OLD."state" = 'settled' AND NEW."state" = 'settled')) THEN RAISE EXCEPTION 'invalid backup admission state transition: % -> %', OLD."state", NEW."state" USING ERRCODE = '55000'; END IF;
  IF OLD."state" = 'queued' AND NEW."state" = 'leased' THEN
    IF OLD."work_kind" = 'schedule_capture' AND OLD."attempts" >= 12 THEN RAISE EXCEPTION 'backup admission schedule claim exhausted its retry attempt limit' USING ERRCODE = '55000'; END IF;
    IF NEW."attempts" <> OLD."attempts" + 1 THEN RAISE EXCEPTION 'backup admission claim must increment attempts once' USING ERRCODE = '55000'; END IF;
    IF NEW."lease_expires_at" IS NULL OR NEW."lease_expires_at" <= statement_timestamp() THEN RAISE EXCEPTION 'backup admission claim requires a live lease' USING ERRCODE = '55000'; END IF;
    SELECT shard."cycle_start_turn", shard."priority_pass", shard."cycle_observed_at", shard."cycle_aging_interval_ms" INTO proof_cycle_start_turn, proof_priority_pass, proof_observed_at, proof_aging_interval_ms FROM "agent_backup_admission_claim_shards" shard WHERE shard."work_kind" = NEW."work_kind" AND shard."shard_id" = NEW."shard_id" AND shard."cycle_observed_at" IS NOT NULL AND (NEW."ready_cohort", NEW."cohort_ordinal", NEW."id") <= (shard."cycle_max_cohort", shard."cycle_max_ordinal", shard."cycle_max_id") FOR UPDATE OF shard;
    IF NOT FOUND THEN RAISE EXCEPTION 'backup admission claim requires exact active cycle authority' USING ERRCODE = '55000'; END IF;
    IF NEW."not_before" > statement_timestamp() THEN RAISE EXCEPTION 'backup admission claim requires ready work' USING ERRCODE = '55000'; END IF;
    IF "agent_backup_admission_effective_priority"(OLD."base_priority", OLD."first_eligible_at", proof_observed_at, proof_aging_interval_ms) <> proof_priority_pass THEN RAISE EXCEPTION 'backup admission claim requires the exact effective priority pass' USING ERRCODE = '55000'; END IF;
    NEW."claim_cycle_start_turn" := proof_cycle_start_turn; NEW."claim_proof_turn" := nextval('agent_backup_admission_claim_turn_seq'); NEW."claim_proof_xid" := pg_current_xact_id(); NEW."claim_proof_priority_pass" := proof_priority_pass; NEW."claim_proof_attempt" := NEW."attempts";
  ELSIF NEW."attempts" IS DISTINCT FROM OLD."attempts" THEN RAISE EXCEPTION 'backup admission attempts change only on claim' USING ERRCODE = '55000'; END IF;
  IF NOT (OLD."state" = 'queued' AND NEW."state" = 'leased') AND ROW(NEW."claim_cycle_start_turn", NEW."claim_proof_turn", NEW."claim_proof_xid", NEW."claim_proof_priority_pass", NEW."claim_proof_attempt") IS DISTINCT FROM ROW(OLD."claim_cycle_start_turn", OLD."claim_proof_turn", OLD."claim_proof_xid", OLD."claim_proof_priority_pass", OLD."claim_proof_attempt") THEN RAISE EXCEPTION 'backup admission claim proof changes only on queued to leased' USING ERRCODE = '55000'; END IF;
  IF NEW."state" = 'leased' OR OLD."state" = NEW."state" THEN IF NEW."not_before" IS DISTINCT FROM OLD."not_before" THEN RAISE EXCEPTION 'backup admission claim preserves readiness' USING ERRCODE = '55000'; END IF; ELSIF NEW."not_before" < OLD."not_before" THEN RAISE EXCEPTION 'backup admission readiness cannot move backward' USING ERRCODE = '55000'; END IF;
  IF OLD."state" IN ('deferred', 'leased') AND NEW."state" = 'queued' THEN IF NEW."ready_cohort" <= OLD."ready_cohort" THEN RAISE EXCEPTION 'backup admission requeue requires a newer cohort' USING ERRCODE = '55000'; END IF; ELSIF OLD."ready_cohort" IS DISTINCT FROM NEW."ready_cohort" OR OLD."cohort_ordinal" IS DISTINCT FROM NEW."cohort_ordinal" THEN RAISE EXCEPTION 'backup admission cohort is immutable outside requeue' USING ERRCODE = '55000'; END IF;
  IF OLD."state" = 'leased' AND NEW."state" = 'leased' THEN
    IF OLD."lease_expires_at" IS NULL OR (OLD."lease_expires_at" <= statement_timestamp() AND OLD.xmin IS DISTINCT FROM pg_current_xact_id()::xid) OR NEW."lease_expires_at" IS NULL OR NEW."lease_expires_at" <= statement_timestamp() THEN RAISE EXCEPTION 'expired backup admission lease cannot be renewed' USING ERRCODE = '55000'; END IF;
    IF OLD."lease_owner" IS DISTINCT FROM NEW."lease_owner" OR OLD."lease_generation" IS DISTINCT FROM NEW."lease_generation" OR NEW."lease_expires_at" < OLD."lease_expires_at" THEN RAISE EXCEPTION 'backup admission lease must preserve its fence and horizon' USING ERRCODE = '55000'; END IF;
  END IF;
  RETURN NEW;
END $$;
