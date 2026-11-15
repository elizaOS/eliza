-- Key renewal carries the owner's sign-in time forward so a renewed mobile
-- credential stays inside that sign-in's absolute lifetime.
-- Nullable: a grant issued before this column counts from its created_at.
ALTER TABLE "mobile_app_auth_grants"
  ADD COLUMN IF NOT EXISTS "session_started_at" timestamp with time zone;
