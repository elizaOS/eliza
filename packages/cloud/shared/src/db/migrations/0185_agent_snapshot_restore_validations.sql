CREATE TABLE IF NOT EXISTS "agent_snapshot_restore_validations" (
  "restore_validation_id" uuid PRIMARY KEY NOT NULL,
  "validation_job_id" uuid NOT NULL,
  "source_job_id" uuid NOT NULL,
  "rollout_id" uuid NOT NULL,
  "standby_generation" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "sandbox_record_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "target_owner_user_id" uuid NOT NULL,
  "backup_id" uuid NOT NULL,
  "capture_nonce" text NOT NULL,
  "source_environment_revision" integer NOT NULL,
  "source_image_digest" text NOT NULL,
  "source_sandbox_id" uuid NOT NULL,
  "target_image" text NOT NULL,
  "target_digest" text NOT NULL,
  "candidate_route_mode" text NOT NULL,
  "validation_state" text NOT NULL,
  "aggregate_sha256" text,
  "target_provider_sandbox_id" text,
  "target_replacement_attempt_id" uuid,
  "target_provider_node_id" text,
  "target_provider_container_name" text,
  "target_provider_container_id" text,
  "target_provider_volume_path" text,
  "target_provider_bridge_url" text,
  "target_provider_health_url" text,
  "target_provider_bridge_port" integer,
  "target_provider_web_ui_port" integer,
  "target_provider_vpn_node_id" text,
  "target_provider_vpn_node_name" text,
  "target_provider_vpn_registration_started_at" timestamp with time zone,
  "target_provider_allocation_counted" boolean,
  "receipt_state" text,
  "receipt_schema_version" integer,
  "receipt_transfer" text,
  "receipt_file_count" integer,
  "receipt_total_bytes" bigint,
  "receipt_requires_restart" boolean,
  "receipt_success" boolean,
  "receipt_committed_at" timestamp with time zone,
  "route_exposed_at" timestamp with time zone,
  "candidate_container_absent_at" timestamp with time zone,
  "candidate_vpn_absent_at" timestamp with time zone,
  "candidate_volume_absent_at" timestamp with time zone,
  "candidate_retired_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_snapshot_restore_validations_contract_check" CHECK (
    "capture_nonce" ~ '^[0-9a-f]{64}$'
    AND "source_environment_revision" >= 0
    AND "source_image_digest" ~ '^sha256:[0-9a-f]{64}$'
    AND "target_digest" ~ '^sha256:[0-9a-f]{64}$'
    AND "candidate_route_mode" = 'restore_validation_private_control'
    AND "route_exposed_at" IS NULL
    AND (
      (
        "validation_state" = 'planned'
        AND "aggregate_sha256" IS NULL
        AND "target_provider_sandbox_id" IS NULL
        AND "target_replacement_attempt_id" IS NULL
        AND "target_provider_node_id" IS NULL
        AND "target_provider_container_name" IS NULL
        AND "target_provider_container_id" IS NULL
        AND "target_provider_volume_path" IS NULL
        AND "target_provider_bridge_url" IS NULL
        AND "target_provider_health_url" IS NULL
        AND "target_provider_bridge_port" IS NULL
        AND "target_provider_web_ui_port" IS NULL
        AND "target_provider_vpn_node_id" IS NULL
        AND "target_provider_vpn_node_name" IS NULL
        AND "target_provider_vpn_registration_started_at" IS NULL
        AND "target_provider_allocation_counted" IS NULL
        AND "receipt_state" IS NULL
        AND "receipt_schema_version" IS NULL
        AND "receipt_transfer" IS NULL
        AND "receipt_file_count" IS NULL
        AND "receipt_total_bytes" IS NULL
        AND "receipt_requires_restart" IS NULL
        AND "receipt_success" IS NULL
        AND "receipt_committed_at" IS NULL
        AND "candidate_container_absent_at" IS NULL
        AND "candidate_vpn_absent_at" IS NULL
        AND "candidate_volume_absent_at" IS NULL
        AND "candidate_retired_at" IS NULL
      )
      OR
      (
        "validation_state" IN (
          'candidate_provisioning',
          'restore_committed',
          'never_routed_retired'
        )
        AND "target_provider_sandbox_id" IS NOT NULL
        AND "target_replacement_attempt_id" IS NOT NULL
        AND "target_provider_node_id" IS NOT NULL
        AND "target_provider_container_name" IS NOT NULL
        AND "target_provider_volume_path" IS NOT NULL
        AND "target_provider_bridge_url" IS NOT NULL
        AND "target_provider_health_url" IS NOT NULL
        AND "target_provider_bridge_port" BETWEEN 1 AND 65535
        AND "target_provider_web_ui_port" BETWEEN 1 AND 65535
        AND "target_provider_vpn_node_name" IS NOT NULL
        AND "target_provider_vpn_registration_started_at" IS NOT NULL
        AND "target_provider_allocation_counted" IS NOT NULL
        AND (
          (
            "validation_state" = 'candidate_provisioning'
            AND "aggregate_sha256" IS NULL
            AND "receipt_state" IS NULL
            AND "receipt_schema_version" IS NULL
            AND "receipt_transfer" IS NULL
            AND "receipt_file_count" IS NULL
            AND "receipt_total_bytes" IS NULL
            AND "receipt_requires_restart" IS NULL
            AND "receipt_success" IS NULL
            AND "receipt_committed_at" IS NULL
            AND "target_provider_allocation_counted" = TRUE
            AND "candidate_container_absent_at" IS NULL
            AND "candidate_vpn_absent_at" IS NULL
            AND "candidate_volume_absent_at" IS NULL
            AND "candidate_retired_at" IS NULL
          )
          OR
          (
            "validation_state" IN ('restore_committed', 'never_routed_retired')
            AND "aggregate_sha256" ~ '^[0-9a-f]{64}$'
            AND "target_provider_container_id" IS NOT NULL
            AND "target_provider_vpn_node_id" IS NOT NULL
            AND "receipt_state" = 'committed'
            AND "receipt_schema_version" = 2
            AND "receipt_transfer" = 'chunked-v1'
            AND "receipt_file_count" >= 0
            AND "receipt_total_bytes" >= 0
            AND "receipt_requires_restart" = TRUE
            AND "receipt_success" = TRUE
            AND "receipt_committed_at" IS NOT NULL
            AND (
              (
                "validation_state" = 'restore_committed'
                AND "target_provider_allocation_counted" = TRUE
                AND "candidate_container_absent_at" IS NULL
                AND "candidate_vpn_absent_at" IS NULL
                AND "candidate_volume_absent_at" IS NULL
                AND "candidate_retired_at" IS NULL
              )
              OR
              (
                "validation_state" = 'never_routed_retired'
                AND "target_provider_allocation_counted" = FALSE
                AND "candidate_container_absent_at" IS NOT NULL
                AND "candidate_vpn_absent_at" IS NOT NULL
                AND "candidate_volume_absent_at" IS NOT NULL
                AND "candidate_retired_at" IS NOT NULL
                AND "candidate_container_absent_at" >= "receipt_committed_at"
                AND "candidate_vpn_absent_at" >= "receipt_committed_at"
                AND "candidate_volume_absent_at" >= "receipt_committed_at"
                AND "candidate_retired_at" >= "candidate_container_absent_at"
                AND "candidate_retired_at" >= "candidate_vpn_absent_at"
                AND "candidate_retired_at" >= "candidate_volume_absent_at"
              )
            )
          )
        )
      )
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_snapshot_restore_validations_job_unique"
  ON "agent_snapshot_restore_validations" ("validation_job_id");

CREATE UNIQUE INDEX IF NOT EXISTS "agent_snapshot_restore_validations_source_unique"
  ON "agent_snapshot_restore_validations" (
    "organization_id",
    "sandbox_record_id",
    "source_job_id",
    "standby_generation"
  );

CREATE UNIQUE INDEX IF NOT EXISTS "agent_snapshot_restore_validations_node_bridge_port_unique"
  ON "agent_snapshot_restore_validations" (
    "target_provider_node_id",
    "target_provider_bridge_port"
  )
  WHERE "target_provider_allocation_counted" = TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS "agent_snapshot_restore_validations_node_web_ui_port_unique"
  ON "agent_snapshot_restore_validations" (
    "target_provider_node_id",
    "target_provider_web_ui_port"
  )
  WHERE "target_provider_allocation_counted" = TRUE;

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
