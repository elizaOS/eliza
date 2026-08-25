-- Additive columns make the telemetry lifecycle deploy-safe before any bounded
-- backfill runs. Legacy NULL expiries are classified by application fallback
-- as started_at + one hour, so they never become valid authentication state.
ALTER TABLE "user_sessions"
  ADD COLUMN IF NOT EXISTS "token_expires_at" timestamp,
  ADD COLUMN IF NOT EXISTS "ended_reason" text,
  ADD COLUMN IF NOT EXISTS "retention_expires_at" timestamp,
  ADD COLUMN IF NOT EXISTS "metadata_purged_at" timestamp;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_sessions_ended_reason_check'
  ) THEN
    ALTER TABLE "user_sessions"
      ADD CONSTRAINT "user_sessions_ended_reason_check" CHECK (
        "ended_reason" IS NULL OR "ended_reason" IN (
          'logout',
          'expired',
          'revoked',
          'idle',
          'administrative_cleanup',
          'legacy_ended'
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "user_sessions_active_lifecycle_idx"
  ON "user_sessions" ("user_id", "token_expires_at", "last_activity_at")
  WHERE "ended_at" IS NULL;

CREATE INDEX IF NOT EXISTS "user_sessions_retention_idx"
  ON "user_sessions" ("retention_expires_at")
  WHERE "ended_at" IS NOT NULL;
