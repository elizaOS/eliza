CREATE TABLE IF NOT EXISTS "remote_hosts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "display_name" text NOT NULL,
  "platform" text NOT NULL,
  "connection_mode" text NOT NULL,
  "headscale_hostname" text,
  "runtime_key_id" text NOT NULL,
  "signing_public_jwk" jsonb NOT NULL,
  "encryption_public_jwk" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "last_seen_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "remote_hosts_platform_check"
    CHECK ("platform" IN ('macos', 'linux', 'windows')),
  CONSTRAINT "remote_hosts_connection_mode_check"
    CHECK ("connection_mode" IN ('managed_headscale', 'ssh', 'direct')),
  CONSTRAINT "remote_hosts_status_check"
    CHECK ("status" IN ('pending', 'online', 'offline', 'revoked'))
);

CREATE INDEX IF NOT EXISTS "remote_hosts_owner_idx"
  ON "remote_hosts" ("organization_id", "user_id");
CREATE INDEX IF NOT EXISTS "remote_hosts_status_idx"
  ON "remote_hosts" ("status");
