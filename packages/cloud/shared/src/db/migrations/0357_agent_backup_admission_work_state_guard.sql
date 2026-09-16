-- Fences claims and records one trigger-owned proof per queued-to-leased admission.

ALTER TABLE "agent_backup_admission_work" ADD COLUMN IF NOT EXISTS "claim_cycle_start_turn" bigint,
  ADD COLUMN IF NOT EXISTS "claim_proof_turn" bigint, ADD COLUMN IF NOT EXISTS "claim_proof_xid" xid8,
  ADD COLUMN IF NOT EXISTS "claim_proof_priority_pass" smallint,
  ADD COLUMN IF NOT EXISTS "claim_proof_attempt" integer;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_backup_admission_work_claim_proof_shape_check'
    AND conrelid = 'agent_backup_admission_work'::regclass) THEN
    ALTER TABLE "agent_backup_admission_work" ADD CONSTRAINT "agent_backup_admission_work_claim_proof_shape_check" CHECK ((
      ("attempts" = 0 AND num_nonnulls("claim_cycle_start_turn", "claim_proof_turn", "claim_proof_xid", "claim_proof_priority_pass", "claim_proof_attempt") = 0)
      OR ("attempts" >= 1 AND "claim_cycle_start_turn" > 0 AND "claim_proof_turn" > 0
        AND "claim_proof_priority_pass" >= 0 AND "claim_proof_attempt" = "attempts"
        AND num_nonnulls("claim_cycle_start_turn", "claim_proof_turn", "claim_proof_xid", "claim_proof_priority_pass", "claim_proof_attempt") = 5)
    ) IS TRUE);
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_work_state"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof_cycle_start_turn bigint; proof_priority_pass smallint;
BEGIN
  IF NOT ((OLD."state" = 'queued' AND NEW."state" IN ('queued', 'deferred', 'leased', 'settled'))
    OR (OLD."state" = 'deferred' AND NEW."state" IN ('deferred', 'queued', 'settled'))
    OR (OLD."state" = 'leased' AND NEW."state" IN ('leased', 'deferred', 'queued', 'settled'))
    OR (OLD."state" = 'settled' AND NEW."state" = 'settled')) THEN
    RAISE EXCEPTION 'invalid backup admission state transition: % -> %', OLD."state", NEW."state" USING ERRCODE = '55000';
  END IF;
  IF OLD."state" = 'queued' AND NEW."state" = 'leased' THEN
    IF NEW."attempts" <> OLD."attempts" + 1 THEN
      RAISE EXCEPTION 'backup admission claim must increment attempts once' USING ERRCODE = '55000';
    END IF;
    IF NEW."lease_expires_at" IS NULL OR NEW."lease_expires_at" <= statement_timestamp() THEN
      RAISE EXCEPTION 'backup admission claim requires a live lease' USING ERRCODE = '55000';
    END IF;
    SELECT shard."cycle_start_turn", shard."priority_pass" INTO proof_cycle_start_turn, proof_priority_pass
    FROM "agent_backup_admission_claim_shards" AS shard
    WHERE shard."work_kind" = NEW."work_kind" AND shard."shard_id" = NEW."shard_id"
      AND shard."cycle_observed_at" IS NOT NULL AND (NEW."ready_cohort", NEW."cohort_ordinal", NEW."id") <=
        (shard."cycle_max_cohort", shard."cycle_max_ordinal", shard."cycle_max_id") FOR UPDATE OF shard;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backup admission claim requires exact active cycle authority' USING ERRCODE = '55000';
    END IF;
    NEW."claim_cycle_start_turn" := proof_cycle_start_turn; NEW."claim_proof_turn" := nextval('agent_backup_admission_claim_turn_seq');
    NEW."claim_proof_xid" := pg_current_xact_id(); NEW."claim_proof_priority_pass" := proof_priority_pass;
    NEW."claim_proof_attempt" := NEW."attempts";
  ELSIF NEW."attempts" IS DISTINCT FROM OLD."attempts" THEN
    RAISE EXCEPTION 'backup admission attempts change only on claim' USING ERRCODE = '55000';
  END IF;
  IF NOT (OLD."state" = 'queued' AND NEW."state" = 'leased') AND ROW(NEW."claim_cycle_start_turn",
    NEW."claim_proof_turn", NEW."claim_proof_xid", NEW."claim_proof_priority_pass", NEW."claim_proof_attempt")
    IS DISTINCT FROM ROW(OLD."claim_cycle_start_turn", OLD."claim_proof_turn", OLD."claim_proof_xid",
      OLD."claim_proof_priority_pass", OLD."claim_proof_attempt") THEN
    RAISE EXCEPTION 'backup admission claim proof changes only on queued to leased' USING ERRCODE = '55000';
  END IF;
  IF NEW."state" = 'leased' OR OLD."state" = NEW."state" THEN
    IF NEW."not_before" IS DISTINCT FROM OLD."not_before" THEN
      RAISE EXCEPTION 'backup admission claim preserves readiness' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW."not_before" < OLD."not_before" THEN
    RAISE EXCEPTION 'backup admission readiness cannot move backward' USING ERRCODE = '55000';
  END IF;
  IF OLD."state" IN ('deferred', 'leased') AND NEW."state" = 'queued' THEN
    IF NEW."ready_cohort" <= OLD."ready_cohort" THEN
      RAISE EXCEPTION 'backup admission requeue requires a newer cohort' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD."ready_cohort" IS DISTINCT FROM NEW."ready_cohort" OR OLD."cohort_ordinal" IS DISTINCT FROM NEW."cohort_ordinal" THEN
    RAISE EXCEPTION 'backup admission cohort is immutable outside requeue' USING ERRCODE = '55000';
  END IF;
  IF OLD."state" = 'leased' AND NEW."state" = 'leased' THEN
    IF OLD."lease_expires_at" IS NULL OR (OLD."lease_expires_at" <= statement_timestamp()
      AND OLD.xmin IS DISTINCT FROM pg_current_xact_id()::xid) OR NEW."lease_expires_at" IS NULL
      OR NEW."lease_expires_at" <= statement_timestamp() THEN
      RAISE EXCEPTION 'expired backup admission lease cannot be renewed' USING ERRCODE = '55000';
    END IF;
    IF OLD."lease_owner" IS DISTINCT FROM NEW."lease_owner" OR OLD."lease_generation" IS DISTINCT FROM NEW."lease_generation"
      OR NEW."lease_expires_at" < OLD."lease_expires_at" THEN
      RAISE EXCEPTION 'backup admission lease must preserve its fence and horizon' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_backup_admission_work_20_state_guard'
    AND tgrelid = 'agent_backup_admission_work'::regclass) THEN
    CREATE TRIGGER "agent_backup_admission_work_20_state_guard" BEFORE UPDATE ON "agent_backup_admission_work"
      FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_admission_work_state"();
  END IF;
END $$;
