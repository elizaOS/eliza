ALTER TABLE "remote_sessions"
  ADD COLUMN IF NOT EXISTS "controller_device_id" text,
  ADD COLUMN IF NOT EXISTS "controller_key_id" text,
  ADD COLUMN IF NOT EXISTS "controller_display_name" text,
  ADD COLUMN IF NOT EXISTS "controller_platform" text,
  ADD COLUMN IF NOT EXISTS "controller_signing_public_jwk" jsonb,
  ADD COLUMN IF NOT EXISTS "controller_encryption_public_jwk" jsonb,
  ADD COLUMN IF NOT EXISTS "last_sequence" bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "remote_sessions_controller_device_id_idx"
  ON "remote_sessions" ("controller_device_id");

ALTER TABLE "remote_sessions"
  DROP CONSTRAINT IF EXISTS "remote_sessions_active_controller_check";

-- Legacy active sessions predate device-bound controller keys and cannot be
-- safely upgraded into the new authority model. End them fail-closed.
UPDATE "remote_sessions"
SET "status" = 'revoked', "ended_at" = now(), "updated_at" = now()
WHERE "status" = 'active'
  AND (
    "controller_device_id" IS NULL
    OR "controller_key_id" IS NULL
    OR "controller_signing_public_jwk" IS NULL
    OR "controller_encryption_public_jwk" IS NULL
  );

ALTER TABLE "remote_sessions"
  ADD CONSTRAINT "remote_sessions_active_controller_check"
  CHECK (
    "status" <> 'active'
    OR (
      "pairing_token_hash" IS NULL
      AND "controller_device_id" IS NOT NULL
      AND "controller_key_id" IS NOT NULL
      AND "controller_signing_public_jwk" IS NOT NULL
      AND "controller_encryption_public_jwk" IS NOT NULL
    )
  );
