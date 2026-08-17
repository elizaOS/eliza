-- Nullable, fail-closed activation authority consumed by backup capture and RPO admission.
-- Restore adds intermediate quarantine phases in a later migration; this slice accepts only
-- legacy all-null rows or one fully published active generation.
-- The lifecycle copy is signed int64 because its source column is PostgreSQL bigint.

ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "activation_generation" uuid,
  ADD COLUMN IF NOT EXISTS "activation_lifecycle_revision" bigint,
  ADD COLUMN IF NOT EXISTS "activation_phase" text,
  ADD COLUMN IF NOT EXISTS "activation_receipt_hash" text,
  ADD COLUMN IF NOT EXISTS "activation_container_id" text,
  ADD COLUMN IF NOT EXISTS "activation_node_id" text,
  ADD COLUMN IF NOT EXISTS "activation_image_digest" text,
  ADD COLUMN IF NOT EXISTS "activation_boot_id" uuid,
  ADD COLUMN IF NOT EXISTS "activation_authority_published_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "activation_dispatched_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "activation_completed_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_sandboxes_activation_generation_idx"
  ON "agent_sandboxes" ("activation_generation")
  WHERE "activation_generation" IS NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_sandboxes_activation_state_check'
      AND conrelid = 'agent_sandboxes'::regclass
  ) THEN
    ALTER TABLE "agent_sandboxes" ADD CONSTRAINT
      "agent_sandboxes_activation_state_check" CHECK (((
        "activation_generation" IS NULL
        AND "activation_lifecycle_revision" IS NULL
        AND "activation_phase" IS NULL
        AND "activation_receipt_hash" IS NULL
        AND "activation_container_id" IS NULL
        AND "activation_node_id" IS NULL
        AND "activation_image_digest" IS NULL
        AND "activation_boot_id" IS NULL
        AND "activation_authority_published_at" IS NULL
        AND "activation_dispatched_at" IS NULL
        AND "activation_completed_at" IS NULL
      ) OR (
        "activation_generation" IS NOT NULL
        AND "activation_lifecycle_revision" IS NOT NULL
        AND "activation_lifecycle_revision" >= 0
        AND "activation_lifecycle_revision" = "lifecycle_revision"
        AND "activation_phase" = 'active'
        AND "activation_receipt_hash" ~ '^[0-9a-f]{64}$'
        AND "activation_container_id" ~ '^[0-9a-f]{64}$'
        AND "sandbox_id" IS NOT NULL
        AND "activation_container_id" <> "sandbox_id"
        AND "activation_node_id" IS NOT NULL AND btrim("activation_node_id") <> ''
        AND "activation_node_id" = "node_id"
        AND "activation_image_digest" ~ '^sha256:[0-9a-f]{64}$'
        AND "activation_image_digest" = "image_digest"
        AND "activation_boot_id" IS NOT NULL
        AND "activation_authority_published_at" IS NOT NULL
        AND "activation_dispatched_at" IS NOT NULL
        AND "activation_completed_at" IS NOT NULL
        AND "activation_authority_published_at" <= "activation_dispatched_at"
        AND "activation_dispatched_at" <= "activation_completed_at"
      )) IS TRUE) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  VALIDATE CONSTRAINT "agent_sandboxes_activation_state_check";
