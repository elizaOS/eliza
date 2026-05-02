CREATE TABLE IF NOT EXISTS "remote_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "status" text NOT NULL,
  "requester_identity" text NOT NULL,
  "pairing_token_hash" text,
  "ingress_url" text,
  "ingress_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  CONSTRAINT "remote_sessions_status_check"
    CHECK ("status" IN ('pending', 'active', 'denied', 'revoked')),
  CONSTRAINT "remote_sessions_organization_id_fkey"
    FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id")
    ON DELETE cascade,
  CONSTRAINT "remote_sessions_user_id_fkey"
    FOREIGN KEY ("user_id")
    REFERENCES "users"("id")
    ON DELETE cascade,
  CONSTRAINT "remote_sessions_agent_id_fkey"
    FOREIGN KEY ("agent_id")
    REFERENCES "eliza_sandboxes"("id")
    ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "remote_sessions_agent_id_idx"
  ON "remote_sessions" ("agent_id");

CREATE INDEX IF NOT EXISTS "remote_sessions_organization_id_idx"
  ON "remote_sessions" ("organization_id");

CREATE INDEX IF NOT EXISTS "remote_sessions_status_idx"
  ON "remote_sessions" ("status");
