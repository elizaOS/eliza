CREATE TABLE IF NOT EXISTS "agent_snapshot_restore_validations" (
  "restore_validation_id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL,
  "sandbox_record_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "target_owner_user_id" uuid NOT NULL,
  "backup_id" uuid NOT NULL,
  "aggregate_sha256" text NOT NULL,
  "capture_nonce" text NOT NULL,
  "source_environment_revision" integer NOT NULL,
  "source_image_digest" text NOT NULL,
  "source_sandbox_id" uuid NOT NULL,
  "target_image" text NOT NULL,
  "target_digest" text NOT NULL,
  "target_provider_sandbox_id" text NOT NULL,
  "target_replacement_attempt_id" uuid NOT NULL,
  "target_provider_node_id" text,
  "target_provider_container_name" text,
  "receipt_state" text NOT NULL,
  "receipt_schema_version" integer NOT NULL,
  "receipt_transfer" text NOT NULL,
  "receipt_file_count" integer NOT NULL,
  "receipt_total_bytes" bigint NOT NULL,
  "receipt_requires_restart" boolean NOT NULL,
  "receipt_success" boolean NOT NULL,
  "receipt_committed_at" timestamp with time zone NOT NULL,
  "candidate_state" text NOT NULL,
  "route_exposed_at" timestamp with time zone,
  "candidate_retired_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_snapshot_restore_validations_contract_check" CHECK (
    "aggregate_sha256" ~ '^[0-9a-f]{64}$'
    AND "capture_nonce" ~ '^[0-9a-f]{64}$'
    AND "source_environment_revision" >= 0
    AND "source_image_digest" ~ '^sha256:[0-9a-f]{64}$'
    AND "target_digest" ~ '^sha256:[0-9a-f]{64}$'
    AND "receipt_state" = 'committed'
    AND "receipt_schema_version" = 2
    AND "receipt_transfer" = 'chunked-v1'
    AND "receipt_file_count" >= 0
    AND "receipt_total_bytes" >= 0
    AND "receipt_requires_restart" = TRUE
    AND "receipt_success" = TRUE
    AND "candidate_state" = 'never_routed_retired'
    AND "route_exposed_at" IS NULL
    AND "candidate_retired_at" >= "receipt_committed_at"
  )
);

CREATE INDEX IF NOT EXISTS "agent_snapshot_restore_validations_backup_idx"
  ON "agent_snapshot_restore_validations" (
    "organization_id",
    "sandbox_record_id",
    "backup_id"
  );

CREATE INDEX IF NOT EXISTS "agent_snapshot_restore_validations_candidate_idx"
  ON "agent_snapshot_restore_validations" (
    "organization_id",
    "agent_id",
    "target_replacement_attempt_id"
  );
