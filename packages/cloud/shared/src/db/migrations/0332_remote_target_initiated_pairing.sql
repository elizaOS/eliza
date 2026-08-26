-- Make the target-created challenge non-authoritative until a same-owner
-- controller claims it and the target explicitly confirms the displayed
-- controller identity. Existing controller-created pending rows remain valid
-- for backwards-compatible activation during rollout.
ALTER TABLE "remote_sessions" DROP CONSTRAINT IF EXISTS "remote_sessions_status_check";
--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_status_check"
  CHECK ("status" IN ('pending', 'claimed', 'activating', 'active', 'denied', 'revoked', 'expired'));
--> statement-breakpoint
ALTER TABLE "remote_sessions" DROP CONSTRAINT IF EXISTS "remote_sessions_host_authority_shape_check";
--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_host_authority_shape_check"
  CHECK ("host_id" IS NULL OR (
    "grant_id" IS NOT NULL AND "grant_revision" > 0
    AND "target_key_id" IS NOT NULL AND "grant_expires_at" IS NOT NULL
  ));
--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_host_controller_identity_atomic_check"
  CHECK ("host_id" IS NULL OR (
    (
      "controller_device_id" IS NULL AND "controller_key_id" IS NULL
      AND "controller_display_name" IS NULL AND "controller_platform" IS NULL
      AND "controller_signing_public_jwk" IS NULL
      AND "controller_encryption_public_jwk" IS NULL
    ) OR (
      "controller_device_id" IS NOT NULL AND "controller_key_id" IS NOT NULL
      AND "controller_display_name" IS NOT NULL AND "controller_platform" IS NOT NULL
      AND "controller_signing_public_jwk" IS NOT NULL
      AND "controller_encryption_public_jwk" IS NOT NULL
    )
  ));
--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_host_pairing_lifecycle_check"
  CHECK ("host_id" IS NULL OR (
    (
      "status" = 'pending' AND "pairing_token_hash" IS NOT NULL
      AND "pairing_consumed_at" IS NULL
    ) OR (
      "status" IN ('claimed', 'activating', 'active')
      AND "controller_device_id" IS NOT NULL
      AND "pairing_token_hash" IS NULL AND "pairing_consumed_at" IS NOT NULL
    ) OR "status" IN ('denied', 'revoked', 'expired')
  ));
