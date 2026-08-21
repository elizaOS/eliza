-- Existing hosts predate host-only relay credentials and remain unable to poll
-- until they are re-enrolled. Keep this nullable so the additive migration is
-- safe on a live database while all newly enrolled hosts receive a token hash.
ALTER TABLE "remote_hosts"
  ADD COLUMN IF NOT EXISTS "host_token_hash" text;

CREATE TABLE IF NOT EXISTS "remote_command_envelopes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "remote_sessions"("id") ON DELETE cascade,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "command_id" text NOT NULL,
  "sequence" bigint NOT NULL,
  "envelope" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "expires_at" timestamp with time zone NOT NULL,
  "claim_expires_at" timestamp with time zone,
  "result_envelope" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  CONSTRAINT "remote_command_envelopes_status_check"
    CHECK ("status" IN ('pending', 'claimed', 'completed', 'expired')),
  CONSTRAINT "remote_command_envelopes_sequence_check" CHECK ("sequence" > 0)
);

CREATE INDEX IF NOT EXISTS "remote_command_envelopes_session_queue_idx"
  ON "remote_command_envelopes" ("session_id", "status", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "remote_command_envelopes_session_command_unique"
  ON "remote_command_envelopes" ("session_id", "command_id");
CREATE UNIQUE INDEX IF NOT EXISTS "remote_command_envelopes_session_sequence_unique"
  ON "remote_command_envelopes" ("session_id", "sequence");
