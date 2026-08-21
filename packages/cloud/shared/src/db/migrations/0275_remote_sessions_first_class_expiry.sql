-- First-class expiry for remote-control pairing sessions (#21784).
-- Legacy rows keep NULL and fall back to the signed expiry embedded in
-- pairing_token_hash; new pending grants are filtered and expired in SQL.
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;
--> statement-breakpoint
-- Migration 0068 constrained status to pending/active/denied/revoked. The
-- terminal `expired` state is a new value, so the deployed CHECK has to be
-- widened here or every expiry transition violates it in production.
ALTER TABLE "remote_sessions" DROP CONSTRAINT IF EXISTS "remote_sessions_status_check";
--> statement-breakpoint
ALTER TABLE "remote_sessions" ADD CONSTRAINT "remote_sessions_status_check"
  CHECK ("status" IN ('pending', 'active', 'denied', 'revoked', 'expired'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_sessions_agent_status_expires_idx"
  ON "remote_sessions" ("agent_id", "status", "expires_at");
