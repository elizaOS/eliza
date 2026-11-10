-- Binds CLI-session key release to the client that created the session.
-- Nullable: sessions created without a verifier keep the legacy behavior.
ALTER TABLE "cli_auth_sessions" ADD COLUMN IF NOT EXISTS "verifier_hash" TEXT;
