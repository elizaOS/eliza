-- Bind both capacity ledgers to the full immutable node occurrence, including
-- the logical node id that may later be reused by a different record.
DO $history_authority$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'agent_node_incarnation_histories'::regclass
      AND conname = 'agent_node_incarnation_histories_logical_authority_unique'
  ) THEN
    ALTER TABLE "agent_node_incarnation_histories"
      ADD CONSTRAINT "agent_node_incarnation_histories_logical_authority_unique"
      UNIQUE ("id", "docker_node_record_id", "node_incarnation", "node_id");
  END IF;
END;
$history_authority$;
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations"
  DROP CONSTRAINT IF EXISTS "agent_backup_restore_operations_node_occurrence_fkey";
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations"
  ADD CONSTRAINT "agent_backup_restore_operations_node_occurrence_fkey"
  FOREIGN KEY (
    "expected_node_history_id", "expected_node_record_id",
    "expected_node_incarnation", "expected_node_id"
  ) REFERENCES "agent_node_incarnation_histories" (
    "id", "docker_node_record_id", "node_incarnation", "node_id"
  ) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_replacement_attempts_node_occurrence_fkey";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_node_occurrence_fkey"
  FOREIGN KEY (
    "locator_node_history_id", "locator_node_record_id",
    "locator_node_incarnation", "locator_node_id"
  ) REFERENCES "agent_node_incarnation_histories" (
    "id", "docker_node_record_id", "node_incarnation", "node_id"
  ) ON DELETE RESTRICT NOT VALID;
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_replacement_attempts_previous_node_occurrence_fkey";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_previous_node_occurrence_fkey"
  FOREIGN KEY (
    "previous_node_history_id", "previous_node_record_id",
    "previous_node_incarnation", "previous_node_id"
  ) REFERENCES "agent_node_incarnation_histories" (
    "id", "docker_node_record_id", "node_incarnation", "node_id"
  ) ON DELETE RESTRICT NOT VALID;
