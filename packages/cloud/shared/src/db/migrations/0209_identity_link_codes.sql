-- Short-lived identity-link challenge codes (#17344): minted for an
-- authenticated eliza.app session, confirmed once from the messaging-channel
-- side to bind that platform handle to the minting account.

CREATE TABLE IF NOT EXISTS "identity_link_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL UNIQUE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "platform_id" text,
  "expires_at" timestamp NOT NULL,
  "consumed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "identity_link_codes_platform_check"
    CHECK ("platform" IN ('telegram', 'discord', 'whatsapp', 'phone')),
  CONSTRAINT "identity_link_codes_status_check"
    CHECK ("status" IN ('pending', 'linked', 'expired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "identity_link_codes_one_pending_per_user_platform_idx"
  ON "identity_link_codes" ("user_id", "platform") WHERE "status" = 'pending';
CREATE INDEX IF NOT EXISTS "identity_link_codes_user_platform_status_idx"
  ON "identity_link_codes" ("user_id", "platform", "status");
CREATE INDEX IF NOT EXISTS "identity_link_codes_expires_at_idx"
  ON "identity_link_codes" ("expires_at");
