-- Contract phase: callers have been rolled out and legacy target/locator rows
-- must be drained or explicitly adopted before strict ownership checks land.
DO $preflight$
BEGIN
  LOCK TABLE "agent_backup_restore_operations",
    "agent_sandbox_replacement_attempts",
    "agent_node_incarnation_histories"
    IN ACCESS EXCLUSIVE MODE NOWAIT;

  IF EXISTS (
    SELECT 1 FROM "agent_backup_restore_operations"
    WHERE "capacity_state" IS NULL
      AND (
        num_nonnulls(
          "expected_node_history_id", "expected_node_record_id",
          "expected_node_incarnation", "expected_container_id",
          "expected_image_digest"
        ) > 0
        OR "phase" = 'finalized'
      )
  ) THEN
    RAISE EXCEPTION
      'capacity contract requires legacy restore targets to be drained or adopted'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "agent_sandbox_replacement_attempts"
    WHERE "capacity_state" IS NULL
      AND num_nonnulls(
        "locator_sandbox_id", "locator_node_id", "locator_container_name",
        "locator_node_record_id", "locator_node_incarnation", "locator_node_history_id",
        "locator_node_hostname", "locator_node_ssh_port", "locator_node_ssh_user",
        "locator_node_host_key_fingerprint", "locator_secret_cleanup_version",
        "locator_allocation_counted", "locator_vpn_node_name",
        "locator_vpn_registration_started_at", "locator_previous_vpn_node_id",
        "locator_recorded_at", "locator_container_id", "locator_container_recorded_at",
        "locator_vpn_node_id", "locator_vpn_recorded_at"
      ) > 0
  ) THEN
    RAISE EXCEPTION
      'capacity contract requires legacy replacement locators to be drained or adopted'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "agent_sandbox_replacement_attempts"
    WHERE "previous_placement_absent" IS NULL
  ) THEN
    RAISE EXCEPTION
      'capacity contract requires previous placement authority on every attempt'
      USING ERRCODE = '55000';
  END IF;
END;
$preflight$;
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations"
  VALIDATE CONSTRAINT "agent_backup_restore_operations_node_occurrence_fkey";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  VALIDATE CONSTRAINT "agent_sandbox_replacement_attempts_node_occurrence_fkey";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  VALIDATE CONSTRAINT "agent_sandbox_replacement_attempts_previous_node_occurrence_fkey";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  VALIDATE CONSTRAINT "agent_sandbox_replacement_attempts_restore_operation_fkey";
