ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "environment_revision" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "deletion_attempt_id" uuid,
  ADD COLUMN IF NOT EXISTS "deletion_started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "warm_claim_credential_state" text,
  ADD COLUMN IF NOT EXISTS "warm_claim_source_pool_id" uuid,
  ADD COLUMN IF NOT EXISTS "warm_claim_key_fingerprint" text,
  ADD COLUMN IF NOT EXISTS "warm_claim_attested_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "warm_claim_attested_environment_revision" integer,
  ADD COLUMN IF NOT EXISTS "warm_claim_cleanup_completed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_sandbox_id" text,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_node_id" text,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_container_name" text,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_attempt_id" uuid,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_container_id" text,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_vpn_node_id" text,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_vpn_node_name" text,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_preserved_vpn_node_id" text,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_vpn_registration_started_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_allocation_counted" boolean,
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_created_at" timestamp with time zone;

DO $$ BEGIN
  ALTER TABLE "agent_sandboxes"
    ADD CONSTRAINT "agent_sandboxes_deletion_intent_pair_check"
    CHECK (
      (
        "deletion_attempt_id" IS NULL
        AND "deletion_started_at" IS NULL
      )
      OR (
        "deletion_attempt_id" IS NOT NULL
        AND "deletion_started_at" IS NOT NULL
      )
    );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  ALTER TABLE "agent_sandboxes"
    ADD CONSTRAINT "agent_sandboxes_warm_claim_credential_state_check"
    CHECK (
      "warm_claim_credential_state" IS NULL
      OR "warm_claim_credential_state" IN ('pending', 'attested', 'ready', 'failed')
    );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "agent_sandboxes"
  DROP CONSTRAINT IF EXISTS "agent_sandboxes_replacement_cleanup_locator_check";

ALTER TABLE "agent_sandboxes"
  ADD CONSTRAINT "agent_sandboxes_replacement_cleanup_locator_check"
  CHECK (
      (
        "replacement_cleanup_sandbox_id" IS NULL
        AND "replacement_cleanup_node_id" IS NULL
        AND "replacement_cleanup_container_name" IS NULL
        AND "replacement_cleanup_attempt_id" IS NULL
        AND "replacement_cleanup_container_id" IS NULL
        AND "replacement_cleanup_vpn_node_id" IS NULL
        AND "replacement_cleanup_vpn_node_name" IS NULL
        AND "replacement_cleanup_preserved_vpn_node_id" IS NULL
        AND "replacement_cleanup_vpn_registration_started_at" IS NULL
        AND "replacement_cleanup_allocation_counted" IS NULL
        AND "replacement_cleanup_created_at" IS NULL
      )
      OR (
        "replacement_cleanup_sandbox_id" IS NOT NULL
        AND "replacement_cleanup_node_id" IS NOT NULL
        AND "replacement_cleanup_container_name" IS NOT NULL
        AND "replacement_cleanup_allocation_counted" IS NOT NULL
        AND "replacement_cleanup_created_at" IS NOT NULL
        AND (
          (
            "replacement_cleanup_attempt_id" IS NOT NULL
            AND (
              (
                "replacement_cleanup_vpn_node_id" IS NULL
                AND
                "replacement_cleanup_vpn_node_name" IS NULL
                AND "replacement_cleanup_vpn_registration_started_at" IS NULL
                AND "replacement_cleanup_preserved_vpn_node_id" IS NULL
              )
              OR (
                "replacement_cleanup_vpn_node_name" IS NOT NULL
                AND "replacement_cleanup_vpn_registration_started_at" IS NOT NULL
              )
            )
          )
          OR (
            "replacement_cleanup_attempt_id" IS NULL
            AND "replacement_cleanup_container_id" IS NULL
            AND "replacement_cleanup_vpn_node_name" IS NULL
            AND "replacement_cleanup_preserved_vpn_node_id" IS NULL
            AND "replacement_cleanup_vpn_registration_started_at" IS NULL
            AND "replacement_cleanup_allocation_counted" = TRUE
          )
        )
      )
  );

CREATE INDEX IF NOT EXISTS "agent_sandboxes_warm_claim_pending_idx"
  ON "agent_sandboxes" ("updated_at")
  WHERE "claimed_at" IS NOT NULL
    AND "warm_claim_credential_state" IS DISTINCT FROM 'ready';

CREATE INDEX IF NOT EXISTS "agent_sandboxes_warm_claim_cleanup_idx"
  ON "agent_sandboxes" ("updated_at")
  WHERE "warm_claim_credential_state" = 'failed'
    AND "warm_claim_cleanup_completed_at" IS NULL;

CREATE INDEX IF NOT EXISTS "agent_sandboxes_replacement_cleanup_pending_idx"
  ON "agent_sandboxes" ("replacement_cleanup_created_at")
  WHERE "replacement_cleanup_sandbox_id" IS NOT NULL;
