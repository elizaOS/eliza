ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "rollback_standby_state" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_generation" uuid,
  ADD COLUMN IF NOT EXISTS "rollback_standby_rollout_id" uuid,
  ADD COLUMN IF NOT EXISTS "rollback_standby_source_job_id" uuid,
  ADD COLUMN IF NOT EXISTS "rollback_standby_decision_job_id" uuid,
  ADD COLUMN IF NOT EXISTS "rollback_standby_verified_backup_id" uuid,
  ADD COLUMN IF NOT EXISTS "rollback_standby_restore_validation_id" uuid,
  ADD COLUMN IF NOT EXISTS "rollback_standby_restore_validation_aggregate_sha256" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_restore_candidate_provider_sandbox_id" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_sandbox_id" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_node_id" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_container_name" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_container_id" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_bridge_url" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_health_url" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_bridge_port" integer,
  ADD COLUMN IF NOT EXISTS "rollback_standby_web_ui_port" integer,
  ADD COLUMN IF NOT EXISTS "rollback_standby_headscale_ip" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_vpn_node_id" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_docker_image" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_image_digest" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_previous_docker_image" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_previous_image_digest" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_environment_revision" integer,
  ADD COLUMN IF NOT EXISTS "rollback_standby_allocation_counted" boolean,
  ADD COLUMN IF NOT EXISTS "rollback_standby_primary_sandbox_id" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_primary_node_id" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_primary_container_name" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_primary_container_id" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_primary_vpn_node_id" text,
  ADD COLUMN IF NOT EXISTS "rollback_standby_primary_replacement_attempt_id" uuid,
  ADD COLUMN IF NOT EXISTS "rollback_standby_created_at" timestamp with time zone;

ALTER TABLE "agent_sandboxes"
  ADD CONSTRAINT "agent_sandboxes_rollback_standby_contract_check"
  CHECK (
    (
      "rollback_standby_state" IS NULL
      AND "rollback_standby_generation" IS NULL
      AND "rollback_standby_rollout_id" IS NULL
      AND "rollback_standby_source_job_id" IS NULL
      AND "rollback_standby_decision_job_id" IS NULL
      AND "rollback_standby_verified_backup_id" IS NULL
      AND "rollback_standby_restore_validation_id" IS NULL
      AND "rollback_standby_restore_validation_aggregate_sha256" IS NULL
      AND "rollback_standby_restore_candidate_provider_sandbox_id" IS NULL
      AND "rollback_standby_sandbox_id" IS NULL
      AND "rollback_standby_node_id" IS NULL
      AND "rollback_standby_container_name" IS NULL
      AND "rollback_standby_container_id" IS NULL
      AND "rollback_standby_bridge_url" IS NULL
      AND "rollback_standby_health_url" IS NULL
      AND "rollback_standby_bridge_port" IS NULL
      AND "rollback_standby_web_ui_port" IS NULL
      AND "rollback_standby_headscale_ip" IS NULL
      AND "rollback_standby_vpn_node_id" IS NULL
      AND "rollback_standby_docker_image" IS NULL
      AND "rollback_standby_image_digest" IS NULL
      AND "rollback_standby_previous_docker_image" IS NULL
      AND "rollback_standby_previous_image_digest" IS NULL
      AND "rollback_standby_environment_revision" IS NULL
      AND "rollback_standby_allocation_counted" IS NULL
      AND "rollback_standby_primary_sandbox_id" IS NULL
      AND "rollback_standby_primary_node_id" IS NULL
      AND "rollback_standby_primary_container_name" IS NULL
      AND "rollback_standby_primary_container_id" IS NULL
      AND "rollback_standby_primary_vpn_node_id" IS NULL
      AND "rollback_standby_primary_replacement_attempt_id" IS NULL
      AND "rollback_standby_created_at" IS NULL
    )
    OR
    (
      "rollback_standby_state" IN (
        'pausing',
        'paused_pre_cutover',
        'paused',
        'retiring',
        'rollback_pending',
        'rollback_cleanup_pending'
      )
      AND "rollback_standby_generation" IS NOT NULL
      AND "rollback_standby_rollout_id" IS NOT NULL
      AND "rollback_standby_source_job_id" IS NOT NULL
      AND "rollback_standby_sandbox_id" IS NOT NULL
      AND "rollback_standby_node_id" IS NOT NULL
      AND "rollback_standby_container_name" IS NOT NULL
      AND "rollback_standby_bridge_url" IS NOT NULL
      AND "rollback_standby_health_url" IS NOT NULL
      AND "rollback_standby_bridge_port" IS NOT NULL
      AND "rollback_standby_web_ui_port" IS NOT NULL
      AND "rollback_standby_vpn_node_id" IS NOT NULL
      AND "rollback_standby_docker_image" IS NOT NULL
      AND "rollback_standby_image_digest" IS NOT NULL
      AND "rollback_standby_environment_revision" IS NOT NULL
      AND "rollback_standby_allocation_counted" = TRUE
      AND "rollback_standby_primary_sandbox_id" IS NOT NULL
      AND "rollback_standby_primary_node_id" IS NOT NULL
      AND "rollback_standby_primary_container_name" IS NOT NULL
      AND "rollback_standby_primary_container_id" IS NOT NULL
      AND "rollback_standby_primary_vpn_node_id" IS NOT NULL
      AND "rollback_standby_primary_replacement_attempt_id" IS NOT NULL
      AND "rollback_standby_created_at" IS NOT NULL
      AND (
        (
          "rollback_standby_state" = 'pausing'
          AND "rollback_standby_container_id" IS NULL
        )
        OR
        (
          "rollback_standby_state" <> 'pausing'
          AND "rollback_standby_container_id" IS NOT NULL
        )
      )
      AND (
        (
          "rollback_standby_state" IN ('pausing', 'paused_pre_cutover', 'paused')
          AND "rollback_standby_decision_job_id" IS NULL
          AND "rollback_standby_verified_backup_id" IS NULL
          AND "rollback_standby_restore_validation_id" IS NULL
          AND "rollback_standby_restore_validation_aggregate_sha256" IS NULL
          AND "rollback_standby_restore_candidate_provider_sandbox_id" IS NULL
        )
        OR
        (
          "rollback_standby_state" = 'retiring'
          AND "rollback_standby_decision_job_id" IS NOT NULL
          AND "rollback_standby_verified_backup_id" IS NOT NULL
          AND "rollback_standby_restore_validation_id" = "rollback_standby_verified_backup_id"
          AND "rollback_standby_restore_validation_aggregate_sha256" ~ '^[0-9a-f]{64}$'
          AND "rollback_standby_restore_candidate_provider_sandbox_id" IS NOT NULL
        )
        OR
        (
          "rollback_standby_state" IN ('rollback_pending', 'rollback_cleanup_pending')
          AND "rollback_standby_decision_job_id" IS NOT NULL
          AND "rollback_standby_verified_backup_id" IS NULL
          AND "rollback_standby_restore_validation_id" IS NULL
          AND "rollback_standby_restore_validation_aggregate_sha256" IS NULL
          AND "rollback_standby_restore_candidate_provider_sandbox_id" IS NULL
        )
      )
      AND (
        (
          "rollback_standby_previous_docker_image" IS NULL
          AND "rollback_standby_previous_image_digest" IS NULL
        )
        OR
        (
          "rollback_standby_previous_docker_image" IS NOT NULL
          AND "rollback_standby_previous_image_digest" IS NOT NULL
        )
      )
    )
  );

CREATE INDEX IF NOT EXISTS "agent_sandboxes_rollback_standby_pending_idx"
  ON "agent_sandboxes" ("rollback_standby_created_at")
  WHERE "rollback_standby_state" IS NOT NULL;
