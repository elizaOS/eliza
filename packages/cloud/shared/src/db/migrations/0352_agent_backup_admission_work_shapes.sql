-- Adds reference, priority, lane, and cohort shape invariants.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conname = 'agent_backup_admission_work_reference_shape_check'
    AND conrelid = 'agent_backup_admission_work'::regclass) THEN
    ALTER TABLE "agent_backup_admission_work" ADD CONSTRAINT
      "agent_backup_admission_work_reference_shape_check" CHECK ((
        ("work_kind" = 'schedule_capture' AND "sandbox_id" IS NOT NULL
          AND "backup_id" IS NULL AND "gc_object_id" IS NULL)
        OR ("work_kind" = 'catalog_operation' AND "sandbox_id" IS NULL
          AND "backup_id" IS NOT NULL AND "gc_object_id" IS NULL)
        OR ("work_kind" = 'gc_object' AND "sandbox_id" IS NULL
          AND "backup_id" IS NULL AND "gc_object_id" IS NOT NULL)
      ) IS TRUE);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conname = 'agent_backup_admission_work_priority_check'
    AND conrelid = 'agent_backup_admission_work'::regclass) THEN
    ALTER TABLE "agent_backup_admission_work" ADD CONSTRAINT
      "agent_backup_admission_work_priority_check" CHECK (((
        ("priority_class" = 'lifecycle_safety' AND "base_priority" = 0)
        OR ("priority_class" = 'active_rpo' AND "base_priority" = 1)
        OR ("priority_class" = 'drain_recovery' AND "base_priority" = 2)
        OR ("priority_class" = 'periodic_capture' AND "base_priority" = 3)
        OR ("priority_class" = 'secondary_replication' AND "base_priority" = 4)
        OR ("priority_class" = 'verification_compaction' AND "base_priority" = 5)
        OR ("priority_class" = 'garbage_collection' AND "base_priority" = 6)
      ) AND (("work_kind" = 'gc_object')
        = ("priority_class" = 'garbage_collection'))) IS TRUE);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conname = 'agent_backup_admission_work_lane_check'
    AND conrelid = 'agent_backup_admission_work'::regclass) THEN
    ALTER TABLE "agent_backup_admission_work" ADD CONSTRAINT
      "agent_backup_admission_work_lane_check" CHECK ((
        "requires_node_lane" = ("node_history_id" IS NOT NULL)
      ) IS TRUE);
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conname = 'agent_backup_admission_work_counters_check'
    AND conrelid = 'agent_backup_admission_work'::regclass) THEN
    ALTER TABLE "agent_backup_admission_work" ADD CONSTRAINT
      "agent_backup_admission_work_counters_check" CHECK ((
        "ready_cohort" >= 0 AND "cohort_ordinal" >= 0
        AND "not_before" >= "source_due_at"
        AND "shard_id" BETWEEN 0 AND 63
        AND "shard_id" = "agent_backup_admission_expected_shard"(
          COALESCE("sandbox_id", "backup_id", "gc_object_id")
        ) AND "attempts" >= 0
      ) IS TRUE);
  END IF;
END $$;
