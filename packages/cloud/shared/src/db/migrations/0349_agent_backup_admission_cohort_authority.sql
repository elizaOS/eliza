-- Creates restartable frozen-snapshot progress for 64 admission shards.

CREATE OR REPLACE FUNCTION "agent_backup_admission_expected_shard"(source_id uuid)
RETURNS smallint LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$ SELECT (get_byte(uuid_send(source_id), 0) % 64)::smallint $$;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "agent_backup_admission_cohort_seq"
  AS bigint MINVALUE 0 START WITH 1;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_admission_enrollment_shards" (
  "work_kind" text NOT NULL,
  "shard_id" smallint NOT NULL,
  "scan_cutoff_at" timestamp with time zone,
  "scan_snapshot" pg_snapshot,
  "scan_cursor_due_at" timestamp with time zone,
  "scan_cursor_id" uuid,
  "scan_cursor_ordinal" integer,
  "scan_schedule_rpo_ms" integer,
  "active_cohort" bigint,
  "lease_owner" text,
  "lease_generation" uuid,
  "lease_expires_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_backup_admission_enrollment_shards_pkey"
    PRIMARY KEY ("work_kind", "shard_id"),
  CONSTRAINT "agent_backup_admission_enrollment_shards_bounds_check" CHECK ((
    "work_kind" IN ('schedule_capture', 'catalog_operation', 'gc_object')
    AND "shard_id" BETWEEN 0 AND 63
  ) IS TRUE),
  CONSTRAINT "agent_backup_admission_enrollment_shards_scan_shape_check" CHECK ((
    ("scan_cutoff_at" IS NULL AND "scan_snapshot" IS NULL
      AND "scan_cursor_due_at" IS NULL AND "scan_cursor_id" IS NULL
      AND "scan_cursor_ordinal" IS NULL AND "scan_schedule_rpo_ms" IS NULL
      AND "active_cohort" IS NULL)
    OR ("scan_cutoff_at" IS NOT NULL AND "scan_snapshot" IS NOT NULL
      AND "active_cohort" >= 0
      AND (("work_kind" = 'schedule_capture'
        AND "scan_schedule_rpo_ms" BETWEEN 60000 AND 900000)
        OR ("work_kind" <> 'schedule_capture' AND "scan_schedule_rpo_ms" IS NULL))
      AND (("scan_cursor_due_at" IS NULL AND "scan_cursor_id" IS NULL
        AND "scan_cursor_ordinal" IS NULL)
        OR ("scan_cursor_due_at" <= "scan_cutoff_at"
          AND "scan_cursor_id" IS NOT NULL AND "scan_cursor_ordinal" >= 0
          AND "agent_backup_admission_expected_shard"("scan_cursor_id") = "shard_id")))
  ) IS TRUE),
  CONSTRAINT "agent_backup_admission_enrollment_shards_lease_shape_check" CHECK ((
    ("lease_owner" IS NULL AND "lease_generation" IS NULL
      AND "lease_expires_at" IS NULL)
    OR ("lease_owner" = btrim("lease_owner")
      AND octet_length("lease_owner") BETWEEN 1 AND 128
      AND "lease_owner" !~ '[[:cntrl:]]'
      AND "lease_generation" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
  ) IS TRUE)
);
