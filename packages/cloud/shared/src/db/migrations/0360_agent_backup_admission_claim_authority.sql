-- Creates restartable, bounded claim-cycle progress for every admission shard.

CREATE SEQUENCE IF NOT EXISTS "agent_backup_admission_claim_turn_seq"
  AS bigint MINVALUE 0 START WITH 1;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_admission_claim_shards" (
  "work_kind" text NOT NULL,
  "shard_id" smallint NOT NULL,
  "last_turn" bigint NOT NULL DEFAULT 0,
  "cycle_start_turn" bigint,
  "cycle_observed_at" timestamp with time zone,
  "cycle_max_cohort" bigint,
  "cycle_max_ordinal" integer,
  "cycle_max_id" uuid,
  "cycle_aging_interval_ms" integer,
  "priority_pass" smallint,
  "scan_cursor_cohort" bigint,
  "scan_cursor_ordinal" integer,
  "scan_cursor_id" uuid,
  "last_admitted_work_id" uuid,
  "last_admission_proof_turn" bigint,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_backup_admission_claim_shards_pkey"
    PRIMARY KEY ("work_kind", "shard_id"),
  CONSTRAINT "agent_backup_admission_claim_shards_bounds_check" CHECK ((
    "work_kind" IN ('schedule_capture', 'catalog_operation', 'gc_object')
    AND "shard_id" BETWEEN 0 AND 63
    AND "last_turn" >= 0
  ) IS TRUE),
  CONSTRAINT "agent_backup_admission_claim_shards_cycle_shape_check" CHECK ((
    ("cycle_observed_at" IS NULL AND "cycle_max_cohort" IS NULL
      AND "cycle_max_ordinal" IS NULL AND "cycle_max_id" IS NULL
      AND "cycle_aging_interval_ms" IS NULL AND "priority_pass" IS NULL
      AND "scan_cursor_cohort" IS NULL AND "scan_cursor_ordinal" IS NULL
      AND "scan_cursor_id" IS NULL AND "last_admitted_work_id" IS NULL)
    OR ("cycle_observed_at" IS NOT NULL AND "cycle_max_cohort" >= 0
      AND "cycle_max_ordinal" >= 0 AND "cycle_max_id" IS NOT NULL
      AND "agent_backup_admission_expected_shard"("cycle_max_id") = "shard_id"
      AND "cycle_aging_interval_ms" BETWEEN 60000 AND 86400000
      AND (("work_kind" = 'schedule_capture' AND "priority_pass" BETWEEN 0 AND 3)
        OR ("work_kind" = 'catalog_operation' AND "priority_pass" BETWEEN 0 AND 5)
        OR ("work_kind" = 'gc_object' AND "priority_pass" BETWEEN 0 AND 6))
      AND (("scan_cursor_cohort" IS NULL AND "scan_cursor_ordinal" IS NULL
          AND "scan_cursor_id" IS NULL)
        OR ("scan_cursor_cohort" BETWEEN 0 AND "cycle_max_cohort"
          AND "scan_cursor_ordinal" >= 0 AND "scan_cursor_id" IS NOT NULL
          AND "agent_backup_admission_expected_shard"("scan_cursor_id") = "shard_id"
          AND ("scan_cursor_cohort", "scan_cursor_ordinal", "scan_cursor_id") <=
            ("cycle_max_cohort", "cycle_max_ordinal", "cycle_max_id"))))
  ) IS TRUE)
);
--> statement-breakpoint
ALTER TABLE "agent_backup_admission_claim_shards"
  ADD COLUMN IF NOT EXISTS "cycle_start_turn" bigint,
  ADD COLUMN IF NOT EXISTS "last_admission_proof_turn" bigint;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conname = 'agent_backup_admission_claim_shards_proof_shape_check'
    AND conrelid = 'agent_backup_admission_claim_shards'::regclass) THEN
    ALTER TABLE "agent_backup_admission_claim_shards" ADD CONSTRAINT
      "agent_backup_admission_claim_shards_proof_shape_check" CHECK ((
        ("cycle_observed_at" IS NULL AND "cycle_start_turn" IS NULL
          AND "last_admitted_work_id" IS NULL AND "last_admission_proof_turn" IS NULL)
        OR ("cycle_observed_at" IS NOT NULL AND "cycle_start_turn" > 0
          AND "cycle_start_turn" <= "last_turn"
          AND (("last_admitted_work_id" IS NULL AND "last_admission_proof_turn" IS NULL)
            OR ("last_admitted_work_id" IS NOT NULL
              AND "last_admission_proof_turn" > "cycle_start_turn"
              AND "last_admission_proof_turn" < "last_turn")))
      ) IS TRUE);
  END IF;
END $$;
