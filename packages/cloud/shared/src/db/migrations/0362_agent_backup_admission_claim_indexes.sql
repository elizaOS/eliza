-- migrate-with-diagnostics: nontransactional-concurrent-indexes
-- Supports bounded claim scans and exact catalogue lane-conflict checks.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_backup_admission_claim_shards_turn_idx"
  ON "agent_backup_admission_claim_shards" ("work_kind", "last_turn", "shard_id");
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_backup_admission_work_claim_scan_idx"
  ON "agent_backup_admission_work" (
    "work_kind", "shard_id", "ready_cohort", "cohort_ordinal", "id"
  ) WHERE "state" = 'queued';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_backup_admission_work_deferred_ready_shard_idx"
  ON "agent_backup_admission_work" (
    "work_kind", "shard_id", "not_before", "id"
  ) WHERE "state" = 'deferred';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_backup_admission_work_expired_lease_shard_idx"
  ON "agent_backup_admission_work" (
    "work_kind", "shard_id", "lease_expires_at", "id"
  ) WHERE "state" = 'leased';
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_sandbox_backups_admission_active_org_idx"
  ON "agent_sandbox_backups" ("catalog_organization_id")
  WHERE "catalog_state" IN (
    'scheduled', 'capturing', 'captured', 'uploading', 'primary_uploaded',
    'primary_verified', 'secondary_pending', 'failed_retryable'
  );
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_sandbox_backups_admission_capture_history_idx"
  ON "agent_sandbox_backups" ("source_node_history_id")
  WHERE "source_node_history_id" IS NOT NULL AND (
    "catalog_state" IN ('scheduled', 'capturing')
    OR ("catalog_state" = 'failed_retryable'
      AND "catalog_resume_state" IN ('scheduled', 'capturing'))
  );
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_sandbox_backups_admission_capture_fallback_idx"
  ON "agent_sandbox_backups" ("source_node_record_id", "source_node_incarnation")
  WHERE "source_node_history_id" IS NULL AND (
    "catalog_state" IN ('scheduled', 'capturing')
    OR ("catalog_state" = 'failed_retryable'
      AND "catalog_resume_state" IN ('scheduled', 'capturing'))
  );
