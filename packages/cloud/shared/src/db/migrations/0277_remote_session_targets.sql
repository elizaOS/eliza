ALTER TABLE "remote_sessions"
  ALTER COLUMN "agent_id" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "host_id" uuid REFERENCES "remote_hosts"("id") ON DELETE cascade;

CREATE INDEX IF NOT EXISTS "remote_sessions_host_id_idx"
  ON "remote_sessions" ("host_id");

ALTER TABLE "remote_sessions"
  DROP CONSTRAINT IF EXISTS "remote_sessions_exactly_one_target_check";

ALTER TABLE "remote_sessions"
  ADD CONSTRAINT "remote_sessions_exactly_one_target_check"
  CHECK (("agent_id" IS NOT NULL) <> ("host_id" IS NOT NULL));
