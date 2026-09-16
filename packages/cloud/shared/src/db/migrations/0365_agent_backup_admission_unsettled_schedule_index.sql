-- migrate-with-diagnostics: nontransactional-concurrent-indexes
-- Bounds outstanding schedule-authority lookup and rejects competing captures.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS
  "agent_backup_admission_work_unsettled_schedule_uidx"
  ON "agent_backup_admission_work" (
    "sandbox_id", "source_activation_generation", "source_lifecycle_revision"
  )
  WHERE "work_kind" = 'schedule_capture' AND "state" <> 'settled';
