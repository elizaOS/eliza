-- Expand the active-only authority into the phases reachable by restore writers.
-- Existing populated authorities are never guessed or silently backfilled.

ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "activation_previous_generation" uuid, ADD COLUMN IF NOT EXISTS "activation_purpose" text,
  ADD COLUMN IF NOT EXISTS "activation_backup_id" uuid, ADD COLUMN IF NOT EXISTS "activation_backup_hash" text,
  ADD COLUMN IF NOT EXISTS "activation_receipt" jsonb, ADD COLUMN IF NOT EXISTS "activation_token_hash" text,
  ADD COLUMN IF NOT EXISTS "activation_token_ciphertext" text, ADD COLUMN IF NOT EXISTS "activation_funding_revision" bigint,
  ADD COLUMN IF NOT EXISTS "activation_consent_lifecycle_revision" bigint, ADD COLUMN IF NOT EXISTS "activation_consent_head_backup_id" uuid,
  ADD COLUMN IF NOT EXISTS "activation_consent_head_backup_hash" text;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    'agent_sandboxes_activation_state_v2_check' AND conrelid = 'agent_sandboxes'::regclass) THEN
    ALTER TABLE "agent_sandboxes" ADD CONSTRAINT
      "agent_sandboxes_activation_state_v2_check" CHECK ((
      (num_nonnulls("activation_generation", "activation_previous_generation",
        "activation_lifecycle_revision", "activation_purpose", "activation_phase",
        "activation_backup_id", "activation_backup_hash", "activation_receipt",
        "activation_receipt_hash", "activation_container_id", "activation_node_id",
        "activation_image_digest", "activation_token_hash", "activation_token_ciphertext",
        "activation_boot_id", "activation_authority_published_at", "activation_funding_revision",
        "activation_dispatched_at", "activation_completed_at",
        "activation_consent_lifecycle_revision", "activation_consent_head_backup_id",
        "activation_consent_head_backup_hash") = 0)
      OR ("activation_generation" IS NOT NULL AND "activation_lifecycle_revision" >= 0
        AND ("activation_purpose" IN ('provision', 'wake', 'restore', 'fresh_boot')
          OR "activation_purpose" IS NULL)
        AND "activation_phase" IN ('container_pending', 'restore_pending', 'restart_pending',
          'restart_attested', 'active', 'blocked')
        AND ("activation_purpose" IS NULL OR (
          "activation_token_hash" ~ '^[0-9a-f]{64}$'
          AND octet_length("activation_token_ciphertext") BETWEEN 1 AND 16384))
        AND (("activation_backup_id" IS NULL AND "activation_backup_hash" IS NULL)
          OR ("activation_backup_id" IS NOT NULL
            AND "activation_backup_hash" ~ '^[0-9a-f]{64}$'))
        AND (("activation_purpose" = 'restore' AND "activation_backup_id" IS NOT NULL)
          OR ("activation_purpose" = 'fresh_boot' AND "activation_backup_id" IS NULL)
          OR "activation_purpose" IN ('provision', 'wake')
          OR ("activation_purpose" IS NULL AND "activation_phase" = 'active'
            AND num_nonnulls("activation_previous_generation", "activation_backup_id",
              "activation_backup_hash", "activation_token_hash", "activation_token_ciphertext",
              "activation_funding_revision", "activation_consent_lifecycle_revision",
              "activation_consent_head_backup_id", "activation_consent_head_backup_hash") = 0))
        AND (("activation_consent_head_backup_id" IS NULL
            AND "activation_consent_head_backup_hash" IS NULL)
          OR ("activation_consent_head_backup_id" IS NOT NULL
            AND "activation_consent_head_backup_hash" ~ '^[0-9a-f]{64}$'))
        AND ("activation_consent_lifecycle_revision" IS NULL
          OR "activation_consent_lifecycle_revision" >= 0)
        AND ("activation_purpose" IS NULL OR "activation_purpose" <> 'fresh_boot'
          OR "activation_consent_lifecycle_revision" IS NOT NULL)
        AND (("activation_purpose" IS NULL AND "activation_receipt" IS NULL
            AND "activation_receipt_hash" ~ '^[0-9a-f]{64}$')
          OR ("activation_receipt" IS NULL AND "activation_receipt_hash" IS NULL)
          OR ("activation_receipt" IS NOT NULL
            AND "activation_receipt_hash" ~ '^[0-9a-f]{64}$'))
        AND ("activation_phase" NOT IN ('restart_pending', 'restart_attested', 'active')
          OR "activation_receipt" IS NOT NULL OR "activation_purpose" IS NULL)
        AND ("activation_phase" NOT IN
          ('restore_pending', 'restart_pending', 'restart_attested', 'active')
          OR ("activation_container_id" ~ '^[0-9a-f]{64}$'
            AND "activation_image_digest" ~ '^sha256:[0-9a-f]{64}$'))
        AND ("activation_phase" NOT IN ('restart_attested', 'active')
          OR "activation_boot_id" IS NOT NULL)
        AND ("activation_phase" <> 'active' OR (("activation_funding_revision" >= 0
            OR ("activation_purpose" IS NULL AND "activation_funding_revision" IS NULL))
          AND "activation_lifecycle_revision" = "lifecycle_revision"
          AND "activation_node_id" IS NOT NULL AND btrim("activation_node_id") <> ''
          AND "activation_node_id" = "node_id" AND "activation_image_digest" = "image_digest"
          AND "sandbox_id" IS NOT NULL AND "activation_container_id" <> "sandbox_id"
          AND "activation_authority_published_at" IS NOT NULL
          AND "activation_dispatched_at" IS NOT NULL AND "activation_completed_at" IS NOT NULL
          AND "activation_authority_published_at" <= "activation_dispatched_at"
          AND "activation_dispatched_at" <= "activation_completed_at"))
        AND ("activation_phase" = 'active' OR ("activation_authority_published_at" IS NULL
          AND "activation_dispatched_at" IS NULL AND "activation_completed_at" IS NULL))
      )) IS TRUE) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "agent_sandboxes" VALIDATE CONSTRAINT "agent_sandboxes_activation_state_v2_check";
--> statement-breakpoint
ALTER TABLE "agent_sandboxes" DROP CONSTRAINT IF EXISTS "agent_sandboxes_activation_state_check";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_sandbox_legacy_activation_write"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW."activation_generation" IS NOT NULL AND NEW."activation_purpose" IS NULL) OR (TG_OP = 'UPDATE' AND ((NEW."activation_generation" IS NOT NULL AND NEW."activation_purpose" IS NULL) OR (OLD."activation_generation" IS NOT NULL AND OLD."activation_purpose" IS NULL))) THEN
    RAISE EXCEPTION 'legacy activation authority is frozen and cannot be written' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END; $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandbox_legacy_activation_write_guard" ON "agent_sandboxes";
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_legacy_activation_write_guard" BEFORE INSERT OR UPDATE OF "activation_generation", "activation_previous_generation", "activation_lifecycle_revision", "activation_purpose", "activation_phase", "activation_backup_id", "activation_backup_hash", "activation_receipt", "activation_receipt_hash", "activation_container_id", "activation_node_id",
  "activation_image_digest", "activation_token_hash", "activation_token_ciphertext", "activation_boot_id", "activation_authority_published_at", "activation_funding_revision", "activation_dispatched_at", "activation_completed_at", "activation_consent_lifecycle_revision", "activation_consent_head_backup_id", "activation_consent_head_backup_hash" ON "agent_sandboxes"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_sandbox_legacy_activation_write"();
