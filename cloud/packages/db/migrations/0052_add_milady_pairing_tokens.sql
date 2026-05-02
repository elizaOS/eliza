CREATE TABLE IF NOT EXISTS "eliza_pairing_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "token_hash" text NOT NULL,
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "instance_url" text NOT NULL,
  "expected_origin" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "eliza_pairing_tokens_token_hash_unique" UNIQUE("token_hash"),
  CONSTRAINT "eliza_pairing_tokens_organization_id_fkey"
    FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id")
    ON DELETE cascade,
  CONSTRAINT "eliza_pairing_tokens_user_id_fkey"
    FOREIGN KEY ("user_id")
    REFERENCES "users"("id")
    ON DELETE cascade,
  CONSTRAINT "eliza_pairing_tokens_agent_id_fkey"
    FOREIGN KEY ("agent_id")
    REFERENCES "eliza_sandboxes"("id")
    ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "eliza_pairing_tokens_token_hash_idx"
  ON "eliza_pairing_tokens" ("token_hash");

CREATE INDEX IF NOT EXISTS "eliza_pairing_tokens_expires_at_idx"
  ON "eliza_pairing_tokens" ("expires_at");

CREATE INDEX IF NOT EXISTS "eliza_pairing_tokens_agent_id_idx"
  ON "eliza_pairing_tokens" ("agent_id");
