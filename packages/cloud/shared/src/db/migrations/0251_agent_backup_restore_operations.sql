-- Durable per-attempt restore coordination with one immutable lease authority
-- tuple and one pre-recorded side-effect identity per phase.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
  'agent_backup_restore_leases_operation_authority_unique') THEN ALTER TABLE
  "agent_backup_restore_leases" ADD CONSTRAINT
  "agent_backup_restore_leases_operation_authority_unique" UNIQUE
  ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id", "owner_id",
   "generation", "catalog_epoch", "copy_role", "operation_id", "activation_generation",
   "lifecycle_revision", "expected_manifest_sha256"); END IF; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_restore_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "agent_id" uuid NOT NULL,
  "backup_id" uuid NOT NULL,
  "restore_attempt_id" uuid NOT NULL,
  "lease_id" uuid NOT NULL,
  "lease_generation" uuid NOT NULL,
  "lease_owner_id" text NOT NULL,
  "catalog_epoch" bigint NOT NULL,
  "copy_role" text NOT NULL,
  "phase" text NOT NULL DEFAULT 'reserved',
  "resume_phase" text,
  "claim_owner" text,
  "claim_generation" uuid,
  "claim_expires_at" timestamptz, "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "expected_manifest_sha256" text NOT NULL,
  "expected_operation_id" uuid NOT NULL,
  "expected_activation_generation" uuid NOT NULL,
  "expected_lifecycle_revision" numeric(20, 0) NOT NULL,
  "expected_node_record_id" uuid,
  "expected_node_incarnation" uuid,
  "expected_container_id" text,
  "expected_image_digest" text,
  "receipt_digest" text, "last_error_code" text,
  "last_error" text,
  "last_failure_generation" uuid,
  "last_failure_digest" text,
  "completed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(), CONSTRAINT
    "agent_backup_restore_operations_lease_authority_fkey" FOREIGN KEY
    ("lease_id", "organization_id", "agent_id", "backup_id", "restore_attempt_id",
     "lease_owner_id", "lease_generation", "catalog_epoch", "copy_role",
     "expected_operation_id", "expected_activation_generation",
     "expected_lifecycle_revision", "expected_manifest_sha256")
    REFERENCES "agent_backup_restore_leases"
    ("id", "organization_id", "agent_id", "backup_id", "restore_attempt_id", "owner_id",
     "generation", "catalog_epoch", "copy_role", "operation_id", "activation_generation",
     "lifecycle_revision", "expected_manifest_sha256")
    ON DELETE RESTRICT, CONSTRAINT "agent_backup_restore_operations_catalog_authority_fkey"
    FOREIGN KEY ("organization_id", "agent_id")
    REFERENCES "agent_backup_catalog_authorities" ("organization_id", "agent_id")
    ON DELETE RESTRICT, CONSTRAINT "agent_backup_restore_operations_phase_check" CHECK ((
    "phase" IN ('reserved','vault_seeded','container_created','restoring','committed',
      'restart_attested','probed','published','finalized','failed_retryable','failed_terminal')
    AND ("resume_phase" IS NULL) = ("phase" <> 'failed_retryable')
    AND ("resume_phase" IS NULL OR "resume_phase" IN ('reserved','vault_seeded',
      'container_created','restoring','committed','restart_attested','probed','published'))
  ) IS TRUE), CONSTRAINT "agent_backup_restore_operations_claim_shape_check" CHECK ((
    ("claim_owner" IS NULL AND "claim_generation" IS NULL AND "claim_expires_at" IS NULL)
    OR ("claim_owner" IS NOT NULL AND btrim("claim_owner") = "claim_owner"
      AND octet_length("claim_owner") BETWEEN 1 AND 255
      AND "claim_generation" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
  ) IS TRUE), CONSTRAINT "agent_backup_restore_operations_receipt_shape_check" CHECK ((
    ("phase" <> 'finalized' AND "completed_at" IS NULL AND "receipt_digest" IS NULL)
    OR ("phase" = 'finalized' AND "completed_at" IS NOT NULL
      AND "receipt_digest" ~ '^[0-9a-f]{64}$')
  ) IS TRUE), CONSTRAINT "agent_backup_restore_operations_failure_replay_check" CHECK ((
    ("last_failure_generation" IS NULL AND "last_failure_digest" IS NULL)
    OR ("last_failure_generation" IS NOT NULL
      AND "last_failure_digest" ~ '^[0-9a-f]{64}$')
  ) IS TRUE), CONSTRAINT "agent_backup_restore_operations_expected_shape_check" CHECK ((
    "attempts" >= 0
    AND "catalog_epoch" >= 0
    AND "expected_lifecycle_revision" BETWEEN 0 AND 18446744073709551615
    AND "expected_manifest_sha256" ~ '^[0-9a-f]{64}$'
    AND "copy_role" IN ('primary','secondary')
    AND btrim("lease_owner_id") = "lease_owner_id"
    AND octet_length("lease_owner_id") BETWEEN 1 AND 255
    AND ("expected_container_id" IS NULL OR "expected_container_id" ~ '^[0-9a-f]{64}$')
    AND ("expected_image_digest" IS NULL OR "expected_image_digest" ~ '^sha256:[0-9a-f]{64}$')
    AND ("expected_node_record_id" IS NULL) = ("expected_node_incarnation" IS NULL)
  ) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_operations_attempt_uidx"
  ON "agent_backup_restore_operations" ("organization_id", "restore_attempt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_operations_one_open_uidx"
  ON "agent_backup_restore_operations" ("organization_id", "backup_id")
  WHERE "phase" NOT IN ('finalized', 'failed_terminal');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_restore_operations_due_idx"
  ON "agent_backup_restore_operations" ("next_attempt_at", "created_at")
  WHERE "phase" NOT IN ('finalized', 'failed_terminal');
