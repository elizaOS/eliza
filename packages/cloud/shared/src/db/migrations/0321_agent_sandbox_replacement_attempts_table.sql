-- Durable one-shot authority for sandbox replacement provider effects. The
-- table retains ambiguous and terminal attempt history for its owner's life.

CREATE TABLE IF NOT EXISTS "agent_sandbox_replacement_attempts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL,
  "operation_kind" text NOT NULL,
  "lifecycle_revision" numeric(20, 0) NOT NULL,
  "activation_generation" uuid NOT NULL,
  "lifecycle_job_id" uuid,
  "lifecycle_execution_generation" uuid,
  "restore_lease_id" uuid,
  "restore_backup_id" uuid,
  "restore_attempt_id" uuid,
  "restore_lease_owner_id" text,
  "restore_lease_generation" uuid,
  "restore_catalog_epoch" bigint,
  "restore_copy_role" text,
  "restore_operation_id" uuid,
  "restore_source_activation_generation" uuid,
  "restore_source_lifecycle_revision" numeric(20, 0),
  "restore_manifest_sha256" text,
  "restore_lease_expires_at" timestamptz,
  "state" text DEFAULT 'in_flight_unresolved' NOT NULL,
  "locator_sandbox_id" text,
  "locator_node_id" text,
  "locator_container_name" text,
  "locator_node_record_id" uuid,
  "locator_node_incarnation" uuid,
  "locator_node_history_id" uuid,
  "locator_node_hostname" text,
  "locator_node_ssh_port" integer,
  "locator_node_ssh_user" text,
  "locator_node_host_key_fingerprint" text,
  "locator_secret_cleanup_version" integer,
  "locator_allocation_counted" boolean,
  "locator_vpn_node_name" text,
  "locator_vpn_registration_started_at" timestamptz,
  "locator_previous_vpn_node_id" text,
  "locator_recorded_at" timestamptz,
  "locator_container_id" text,
  "locator_container_recorded_at" timestamptz,
  "locator_vpn_node_id" text,
  "locator_vpn_recorded_at" timestamptz,
  "provider_succeeded_at" timestamptz,
  "provider_receipt_digest" text,
  "lifecycle_committed_at" timestamptz,
  "lifecycle_receipt_digest" text,
  "cleanup_proven_at" timestamptz,
  "cleanup_receipt_digest" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "agent_sandbox_replacement_attempts_restore_lease_fkey" FOREIGN KEY (
    "restore_lease_id", "organization_id", "agent_id", "restore_backup_id",
    "restore_attempt_id", "restore_lease_owner_id", "restore_lease_generation",
    "restore_catalog_epoch", "restore_copy_role", "restore_operation_id",
    "restore_source_activation_generation", "restore_source_lifecycle_revision",
    "restore_manifest_sha256"
  ) REFERENCES "agent_backup_restore_leases" (
    "id", "organization_id", "agent_id", "backup_id", "restore_attempt_id",
    "owner_id", "generation", "catalog_epoch", "copy_role", "operation_id",
    "activation_generation", "lifecycle_revision", "expected_manifest_sha256"
  ) ON DELETE RESTRICT,
  CONSTRAINT "agent_sandbox_replacement_attempts_node_occurrence_fkey" FOREIGN KEY (
    "locator_node_history_id", "locator_node_record_id", "locator_node_incarnation"
  ) REFERENCES "agent_node_incarnation_histories" (
    "id", "docker_node_record_id", "node_incarnation"
  ) ON DELETE RESTRICT
);
