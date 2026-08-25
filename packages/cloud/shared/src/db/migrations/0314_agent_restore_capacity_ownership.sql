-- Expand phase only: migrations run before the worker restarts, so the old
-- binary must be able to keep writing legacy target and locator tuples.
ALTER TABLE "agent_backup_restore_operations"
  ADD COLUMN IF NOT EXISTS "expected_node_id" text,
  ADD COLUMN IF NOT EXISTS "capacity_state" text,
  ADD COLUMN IF NOT EXISTS "capacity_reserved_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "capacity_settled_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "capacity_settlement_receipt_digest" text;
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD COLUMN IF NOT EXISTS "capacity_state" text,
  ADD COLUMN IF NOT EXISTS "capacity_reserved_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "capacity_settled_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "capacity_settlement_receipt_digest" text,
  ADD COLUMN IF NOT EXISTS "previous_placement_absent" boolean,
  ADD COLUMN IF NOT EXISTS "previous_sandbox_id" text,
  ADD COLUMN IF NOT EXISTS "previous_node_id" text,
  ADD COLUMN IF NOT EXISTS "previous_container_name" text,
  ADD COLUMN IF NOT EXISTS "previous_container_id" text,
  ADD COLUMN IF NOT EXISTS "previous_allocation_counted" boolean,
  ADD COLUMN IF NOT EXISTS "previous_node_record_id" uuid,
  ADD COLUMN IF NOT EXISTS "previous_node_incarnation" uuid,
  ADD COLUMN IF NOT EXISTS "previous_node_history_id" uuid,
  ADD COLUMN IF NOT EXISTS "previous_node_hostname" text,
  ADD COLUMN IF NOT EXISTS "previous_node_ssh_port" integer,
  ADD COLUMN IF NOT EXISTS "previous_node_ssh_user" text,
  ADD COLUMN IF NOT EXISTS "previous_node_host_key_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_replacement_attempts_previous_placement_mode_check";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT IF EXISTS "agent_sandbox_replacement_attempts_previous_placement_shape_check";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_previous_placement_mode_check"
  CHECK (("previous_placement_absent" IS NULL
    OR "previous_placement_absent" = FALSE
    OR ("previous_placement_absent" = TRUE
      AND "operation_kind" = 'provision'
      AND "restore_attempt_id" IS NULL)) IS TRUE) NOT VALID;
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_previous_placement_shape_check"
  CHECK ((CASE
    WHEN "previous_placement_absent" IS NULL OR "previous_placement_absent" = TRUE THEN
      num_nonnulls(
        "previous_sandbox_id", "previous_node_id", "previous_container_name",
        "previous_container_id", "previous_allocation_counted", "previous_node_record_id",
        "previous_node_incarnation", "previous_node_history_id", "previous_node_hostname",
        "previous_node_ssh_port", "previous_node_ssh_user",
        "previous_node_host_key_fingerprint") = 0
    ELSE
      "previous_sandbox_id" IS NOT NULL AND "previous_node_id" IS NOT NULL
      AND "previous_container_name" IS NOT NULL
      AND "previous_container_id" ~ '^[0-9a-f]{64}$'
      AND "previous_allocation_counted" = TRUE
      AND "previous_node_record_id" IS NOT NULL
      AND "previous_node_incarnation" IS NOT NULL
      AND "previous_node_history_id" IS NOT NULL
      AND btrim("previous_node_hostname") <> ''
      AND octet_length("previous_node_hostname") <= 255
      AND "previous_node_ssh_port" BETWEEN 1 AND 65535
      AND btrim("previous_node_ssh_user") <> ''
      AND octet_length("previous_node_ssh_user") <= 255
      AND btrim("previous_node_host_key_fingerprint") <> ''
      AND octet_length("previous_node_host_key_fingerprint") <= 1024
    END) IS TRUE) NOT VALID;
