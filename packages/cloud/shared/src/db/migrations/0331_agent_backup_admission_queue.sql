-- Unified, explicit backup admission queue with restartable bounded shard scans.

CREATE OR REPLACE FUNCTION "agent_backup_admission_expected_shard"(source_id uuid)
RETURNS smallint
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT (get_byte(uuid_send(source_id), 0) % 64)::smallint
$$;
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "agent_backup_admission_cohort_seq"
  AS bigint MINVALUE 0 START WITH 1;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_backup_gc_outbox_tenant_identity_unique'
  ) THEN
    ALTER TABLE "agent_backup_gc_outbox"
      ADD CONSTRAINT "agent_backup_gc_outbox_tenant_identity_unique"
      UNIQUE ("id", "organization_id");
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_admission_enrollment_shards" (
  "work_kind" text NOT NULL,
  "shard_id" smallint NOT NULL,
  "scan_cutoff_at" timestamp with time zone,
  "scan_cursor_due_at" timestamp with time zone,
  "scan_cursor_id" uuid,
  "active_cohort" bigint,
  "lease_owner" text,
  "lease_generation" uuid,
  "lease_expires_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_backup_admission_enrollment_shards_pkey"
    PRIMARY KEY ("work_kind", "shard_id"),
  CONSTRAINT "agent_backup_admission_enrollment_shards_bounds_check" CHECK (
    "work_kind" IN ('schedule_capture', 'catalog_operation', 'gc_object')
    AND "shard_id" BETWEEN 0 AND 63
  ),
  CONSTRAINT "agent_backup_admission_enrollment_shards_scan_shape_check" CHECK (
    (
      "scan_cutoff_at" IS NULL
      AND "scan_cursor_due_at" IS NULL
      AND "scan_cursor_id" IS NULL
      AND "active_cohort" IS NULL
    ) OR (
      "scan_cutoff_at" IS NOT NULL
      AND "active_cohort" IS NOT NULL
      AND "active_cohort" >= 0
      AND (
        ("scan_cursor_due_at" IS NULL AND "scan_cursor_id" IS NULL)
        OR ("scan_cursor_due_at" IS NOT NULL AND "scan_cursor_id" IS NOT NULL)
      )
    )
  ),
  CONSTRAINT "agent_backup_admission_enrollment_shards_lease_shape_check" CHECK (
    (
      "lease_owner" IS NULL
      AND "lease_generation" IS NULL
      AND "lease_expires_at" IS NULL
    ) OR (
      "lease_owner" IS NOT NULL
      AND btrim("lease_owner") <> ''
      AND octet_length("lease_owner") <= 128
      AND "lease_generation" IS NOT NULL
      AND "lease_expires_at" IS NOT NULL
    )
  )
);
--> statement-breakpoint
INSERT INTO "agent_backup_admission_enrollment_shards" ("work_kind", "shard_id")
SELECT work_kind, shard_id
FROM unnest(ARRAY['schedule_capture', 'catalog_operation', 'gc_object']::text[]) AS work_kind
CROSS JOIN generate_series(0, 63) AS shard_id
ON CONFLICT ("work_kind", "shard_id") DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_admission_work" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "work_kind" text NOT NULL,
  "organization_id" uuid NOT NULL
    REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "sandbox_id" uuid,
  "backup_id" uuid,
  "gc_outbox_id" uuid,
  "node_history_id" uuid
    REFERENCES "agent_node_incarnation_histories"("id") ON DELETE RESTRICT,
  "requires_node_lane" boolean NOT NULL,
  "priority_class" text NOT NULL,
  "base_priority" smallint NOT NULL,
  "source_due_at" timestamp with time zone NOT NULL,
  "first_eligible_at" timestamp with time zone NOT NULL DEFAULT now(),
  "state" text NOT NULL DEFAULT 'queued',
  "not_before" timestamp with time zone NOT NULL DEFAULT now(),
  "deferred_reason" text,
  "ready_cohort" bigint NOT NULL,
  "cohort_ordinal" integer NOT NULL,
  "shard_id" smallint NOT NULL,
  "lease_owner" text,
  "lease_generation" uuid,
  "lease_expires_at" timestamp with time zone,
  "attempts" integer NOT NULL DEFAULT 0,
  "settled_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_backup_admission_work_sandbox_tenant_fkey"
    FOREIGN KEY ("sandbox_id", "organization_id")
    REFERENCES "agent_sandboxes"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_admission_work_backup_tenant_fkey"
    FOREIGN KEY ("backup_id", "organization_id")
    REFERENCES "agent_sandbox_backups"("id", "catalog_organization_id") ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_admission_work_gc_tenant_fkey"
    FOREIGN KEY ("gc_outbox_id", "organization_id")
    REFERENCES "agent_backup_gc_outbox"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "agent_backup_admission_work_reference_shape_check" CHECK (
    (
      "work_kind" = 'schedule_capture'
      AND "sandbox_id" IS NOT NULL
      AND "backup_id" IS NULL
      AND "gc_outbox_id" IS NULL
    ) OR (
      "work_kind" = 'catalog_operation'
      AND "sandbox_id" IS NULL
      AND "backup_id" IS NOT NULL
      AND "gc_outbox_id" IS NULL
    ) OR (
      "work_kind" = 'gc_object'
      AND "sandbox_id" IS NULL
      AND "backup_id" IS NULL
      AND "gc_outbox_id" IS NOT NULL
    )
  ),
  CONSTRAINT "agent_backup_admission_work_priority_check" CHECK (
    (
      ("priority_class" = 'lifecycle_safety' AND "base_priority" = 0)
      OR ("priority_class" = 'active_rpo' AND "base_priority" = 1)
      OR ("priority_class" = 'drain_recovery' AND "base_priority" = 2)
      OR ("priority_class" = 'periodic_capture' AND "base_priority" = 3)
      OR ("priority_class" = 'secondary_replication' AND "base_priority" = 4)
      OR ("priority_class" = 'verification_compaction' AND "base_priority" = 5)
      OR ("priority_class" = 'garbage_collection' AND "base_priority" = 6)
    ) AND (
      "work_kind" <> 'gc_object'
      OR "priority_class" = 'garbage_collection'
    )
  ),
  CONSTRAINT "agent_backup_admission_work_lane_check" CHECK (
    (NOT "requires_node_lane" OR "node_history_id" IS NOT NULL)
    AND (
      "work_kind" <> 'schedule_capture'
      OR ("requires_node_lane" AND "node_history_id" IS NOT NULL)
    )
    AND (
      "work_kind" <> 'gc_object'
      OR (NOT "requires_node_lane" AND "node_history_id" IS NULL)
    )
  ),
  CONSTRAINT "agent_backup_admission_work_state_shape_check" CHECK (
    (
      "state" = 'queued'
      AND "deferred_reason" IS NULL
      AND "lease_owner" IS NULL
      AND "lease_generation" IS NULL
      AND "lease_expires_at" IS NULL
      AND "settled_at" IS NULL
    ) OR (
      "state" = 'deferred'
      AND "deferred_reason" ~ '^[A-Z][A-Z0-9_]{0,95}$'
      AND "lease_owner" IS NULL
      AND "lease_generation" IS NULL
      AND "lease_expires_at" IS NULL
      AND "settled_at" IS NULL
    ) OR (
      "state" = 'leased'
      AND "deferred_reason" IS NULL
      AND "lease_owner" IS NOT NULL
      AND btrim("lease_owner") <> ''
      AND octet_length("lease_owner") <= 128
      AND "lease_generation" IS NOT NULL
      AND "lease_expires_at" IS NOT NULL
      AND "settled_at" IS NULL
    ) OR (
      "state" = 'settled'
      AND "deferred_reason" IS NULL
      AND "lease_owner" IS NULL
      AND "lease_generation" IS NULL
      AND "lease_expires_at" IS NULL
      AND "settled_at" IS NOT NULL
    )
  ),
  CONSTRAINT "agent_backup_admission_work_counters_check" CHECK (
    "ready_cohort" >= 0
    AND "cohort_ordinal" >= 0
    AND "shard_id" BETWEEN 0 AND 63
    AND "shard_id" = "agent_backup_admission_expected_shard"(
      COALESCE("sandbox_id", "backup_id", "gc_outbox_id")
    )
    AND "attempts" >= 0
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_admission_work_schedule_uidx"
  ON "agent_backup_admission_work" ("sandbox_id", "source_due_at")
  WHERE "work_kind" = 'schedule_capture';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_admission_work_operation_uidx"
  ON "agent_backup_admission_work" ("backup_id")
  WHERE "work_kind" = 'catalog_operation';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_admission_work_gc_uidx"
  ON "agent_backup_admission_work" ("gc_outbox_id")
  WHERE "work_kind" = 'gc_object';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_admission_work_due_idx"
  ON "agent_backup_admission_work" (
    "state", "not_before", "base_priority", "first_eligible_at",
    "ready_cohort", "cohort_ordinal", "id"
  )
  WHERE "state" IN ('queued', 'deferred', 'leased');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_admission_work_shard_idx"
  ON "agent_backup_admission_work" (
    "work_kind", "shard_id", "source_due_at", "id"
  )
  WHERE "state" <> 'settled';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_admission_work"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."work_kind" IS DISTINCT FROM NEW."work_kind"
    OR OLD."organization_id" IS DISTINCT FROM NEW."organization_id"
    OR OLD."sandbox_id" IS DISTINCT FROM NEW."sandbox_id"
    OR OLD."backup_id" IS DISTINCT FROM NEW."backup_id"
    OR OLD."gc_outbox_id" IS DISTINCT FROM NEW."gc_outbox_id"
    OR OLD."node_history_id" IS DISTINCT FROM NEW."node_history_id"
    OR OLD."source_due_at" IS DISTINCT FROM NEW."source_due_at"
    OR OLD."first_eligible_at" IS DISTINCT FROM NEW."first_eligible_at"
    OR OLD."shard_id" IS DISTINCT FROM NEW."shard_id"
  THEN
    RAISE EXCEPTION 'backup admission work identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."ready_cohort" < OLD."ready_cohort" THEN
    RAISE EXCEPTION 'backup admission cohort cannot move backward'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'backup admission attempts cannot move backward'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."state" = 'settled' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'settled backup admission work is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."state" = 'deferred' AND NEW."state" = 'leased' THEN
    RAISE EXCEPTION 'deferred backup admission work must re-enter a queued cohort'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_admission_work_guard"
  ON "agent_backup_admission_work";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_admission_work_guard"
BEFORE UPDATE ON "agent_backup_admission_work"
FOR EACH ROW
EXECUTE FUNCTION "guard_agent_backup_admission_work"();
