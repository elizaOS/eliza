-- First-class expiry for remote-control pairing sessions (#21784).
-- Legacy rows keep NULL and fall back to the signed expiry embedded in
-- pairing_token_hash; new pending grants are filtered and expired in SQL.
ALTER TABLE "remote_sessions" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_sessions_agent_status_expires_idx"
  ON "remote_sessions" ("agent_id", "status", "expires_at");
