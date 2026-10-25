-- migrate-with-diagnostics: nontransactional-concurrent-indexes
-- Bounds the three exact schedule-enrollment source frontiers.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_sandboxes_backup_admission_initial_frontier_idx"
  ON "agent_sandboxes" ((get_byte(uuid_send("id"), 0) % 64), "activation_completed_at", "id")
  WHERE "next_backup_at" IS NULL
    AND "status" = 'running' AND "pool_status" IS NULL
    AND "execution_tier" IN ('dedicated-lazy', 'dedicated-always', 'custom')
    AND "deleted_at" IS NULL AND "deletion_attempt_id" IS NULL
    AND "activation_phase" = 'active' AND "activation_generation" IS NOT NULL
    AND "activation_lifecycle_revision" IS NOT NULL
    AND "lifecycle_revision" = "activation_lifecycle_revision"
    AND "activation_receipt_hash" ~ '^[0-9a-f]{64}$'
    AND "activation_container_id" ~ '^[0-9a-f]{64}$'
    AND "sandbox_id" IS NOT NULL AND btrim("sandbox_id") <> ''
    AND "sandbox_id" = btrim("sandbox_id") AND "sandbox_id" !~ '[[:cntrl:]]'
    AND octet_length("sandbox_id") <= 512 AND "sandbox_id" <> "activation_container_id"
    AND "activation_node_id" IS NOT NULL AND "activation_boot_id" IS NOT NULL
    AND "activation_image_digest" ~ '^sha256:[0-9a-f]{64}$'
    AND "activation_authority_published_at" IS NOT NULL
    AND "activation_dispatched_at" IS NOT NULL AND "activation_completed_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_sandboxes_backup_admission_scheduled_frontier_idx"
  ON "agent_sandboxes" ((get_byte(uuid_send("id"), 0) % 64), "next_backup_at", "id")
  WHERE "next_backup_at" IS NOT NULL
    AND "status" = 'running' AND "pool_status" IS NULL
    AND "execution_tier" IN ('dedicated-lazy', 'dedicated-always', 'custom')
    AND "deleted_at" IS NULL AND "deletion_attempt_id" IS NULL
    AND "activation_phase" = 'active' AND "activation_generation" IS NOT NULL
    AND "activation_lifecycle_revision" IS NOT NULL
    AND "lifecycle_revision" = "activation_lifecycle_revision"
    AND "activation_receipt_hash" ~ '^[0-9a-f]{64}$'
    AND "activation_container_id" ~ '^[0-9a-f]{64}$'
    AND "sandbox_id" IS NOT NULL AND btrim("sandbox_id") <> ''
    AND "sandbox_id" = btrim("sandbox_id") AND "sandbox_id" !~ '[[:cntrl:]]'
    AND octet_length("sandbox_id") <= 512 AND "sandbox_id" <> "activation_container_id"
    AND "activation_node_id" IS NOT NULL AND "activation_boot_id" IS NOT NULL
    AND "activation_image_digest" ~ '^sha256:[0-9a-f]{64}$'
    AND "activation_authority_published_at" IS NOT NULL
    AND "activation_dispatched_at" IS NOT NULL AND "activation_completed_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_sandboxes_backup_admission_rpo_frontier_idx"
  ON "agent_sandboxes" ((get_byte(uuid_send("id"), 0) % 64),
    GREATEST("activation_completed_at",
      COALESCE("backup_schedule_last_protected_at", "activation_completed_at")), "id")
  WHERE "next_backup_at" IS NOT NULL
    AND "status" = 'running' AND "pool_status" IS NULL
    AND "execution_tier" IN ('dedicated-lazy', 'dedicated-always', 'custom')
    AND "deleted_at" IS NULL AND "deletion_attempt_id" IS NULL
    AND "activation_phase" = 'active' AND "activation_generation" IS NOT NULL
    AND "activation_lifecycle_revision" IS NOT NULL
    AND "lifecycle_revision" = "activation_lifecycle_revision"
    AND "activation_receipt_hash" ~ '^[0-9a-f]{64}$'
    AND "activation_container_id" ~ '^[0-9a-f]{64}$'
    AND "sandbox_id" IS NOT NULL AND btrim("sandbox_id") <> ''
    AND "sandbox_id" = btrim("sandbox_id") AND "sandbox_id" !~ '[[:cntrl:]]'
    AND octet_length("sandbox_id") <= 512 AND "sandbox_id" <> "activation_container_id"
    AND "activation_node_id" IS NOT NULL AND "activation_boot_id" IS NOT NULL
    AND "activation_image_digest" ~ '^sha256:[0-9a-f]{64}$'
    AND "activation_authority_published_at" IS NOT NULL
    AND "activation_dispatched_at" IS NOT NULL AND "activation_completed_at" IS NOT NULL;
