-- Expand phase: give restore handoff one tenant-scoped source, one receiver, and indexed
-- occurrence lookups for cardinality reconciliation.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_operations_attempt_uidx"
  ON "agent_backup_restore_operations" ("organization_id", "restore_attempt_id");
--> statement-breakpoint
DO $restore_attempt_authority$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_backup_restore_operations'::regclass
      AND conname = 'agent_backup_restore_operations_attempt_uidx'
  ) THEN
    ALTER TABLE "agent_backup_restore_operations"
      ADD CONSTRAINT "agent_backup_restore_operations_attempt_uidx"
      UNIQUE USING INDEX "agent_backup_restore_operations_attempt_uidx";
  END IF;
END;
$restore_attempt_authority$;
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_replacement_attempts_restore_operation_fkey";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_restore_operation_fkey"
  FOREIGN KEY ("organization_id", "restore_attempt_id")
  REFERENCES "agent_backup_restore_operations" ("organization_id", "restore_attempt_id")
  ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS
  "agent_sandbox_replacement_restore_capacity_receiver_uidx"
  ON "agent_sandbox_replacement_attempts" ("organization_id", "restore_attempt_id")
  WHERE "restore_attempt_id" IS NOT NULL AND "capacity_state" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_restore_capacity_reserved_occurrence_idx"
  ON "agent_backup_restore_operations" (
    "expected_node_record_id", "expected_node_id",
    "expected_node_incarnation", "expected_node_history_id"
  ) WHERE "capacity_state" = 'reserved';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_sandbox_replacement_capacity_reserved_occurrence_idx"
  ON "agent_sandbox_replacement_attempts" (
    "locator_node_record_id", "locator_node_id",
    "locator_node_incarnation", "locator_node_history_id"
  ) WHERE "capacity_state" = 'reserved';
