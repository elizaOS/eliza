-- Partial index over active sessions only (ended_at IS NULL).
-- Active session lookup currently uses user_sessions_active_idx (on ended_at) which
-- includes every closed session; this partial index keeps only the live rows.
CREATE INDEX IF NOT EXISTS "user_sessions_active_user_idx"
  ON "user_sessions" USING btree ("user_id")
  WHERE "ended_at" IS NULL;
