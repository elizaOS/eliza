-- Partial index over active sessions only. Powers the cleanup cron that scans
-- for expired-but-still-active sessions; the existing full-table expires_at_idx
-- forces a scan over all historical sessions.
CREATE INDEX IF NOT EXISTS "anon_sessions_active_expires_idx"
  ON "anonymous_sessions" USING btree ("expires_at")
  WHERE "is_active" = true;
