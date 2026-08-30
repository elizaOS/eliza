-- Enforces replay identities, exact active lanes, and bounded claim scans.

CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_admission_work_schedule_uidx"
  ON "agent_backup_admission_work" (
    "sandbox_id", "node_history_id", "source_activation_generation",
    "source_lifecycle_revision", "source_due_at"
  ) WHERE "work_kind" = 'schedule_capture'
    AND NOT ("state" = 'settled' AND "settled_reason" = 'RETRY_EXHAUSTED'
      AND "attempts" = 12);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_admission_work_operation_stage_uidx"
  ON "agent_backup_admission_work" ("backup_id", "work_stage");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_admission_work_gc_uidx"
  ON "agent_backup_admission_work" ("gc_object_id", "work_stage");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_admission_work_organization_idx"
  ON "agent_backup_admission_work" ("organization_id", "id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_admission_work_leased_organization_uidx"
  ON "agent_backup_admission_work" ("organization_id") WHERE "state" = 'leased';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_admission_work_leased_node_uidx"
  ON "agent_backup_admission_work" ("node_history_id")
  WHERE "state" = 'leased' AND "node_history_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_admission_work_due_idx"
  ON "agent_backup_admission_work" (
    "state", "not_before", "base_priority", "first_eligible_at",
    "ready_cohort", "cohort_ordinal", "id"
  ) WHERE "state" IN ('queued', 'deferred', 'leased');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_admission_work_shard_idx"
  ON "agent_backup_admission_work" ("work_kind", "shard_id", "source_due_at", "id")
  WHERE "state" <> 'settled';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_admission_work_expired_lease_idx"
  ON "agent_backup_admission_work" ("lease_expires_at", "id") WHERE "state" = 'leased';
