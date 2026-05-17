-- Vendor Connections table for SaaS OAuth tokens vended to the agent.
-- Tokens are encrypted at rest using AES-256-GCM envelope encryption
-- (same pattern as discord_connections, see 0023_add_discord_connections.sql).

CREATE TABLE IF NOT EXISTS "vendor_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "vendor" text NOT NULL,
  "label" text,
  "access_token_encrypted" text NOT NULL,
  "refresh_token_encrypted" text,
  "encrypted_dek" text NOT NULL,
  "token_nonce" text NOT NULL,
  "token_auth_tag" text NOT NULL,
  "encryption_key_id" text NOT NULL,
  "expires_at" timestamp with time zone,
  "scopes" text[] NOT NULL DEFAULT ARRAY[]::text[],
  "connection_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "vendor_connections_organization_id_idx"
  ON "vendor_connections" ("organization_id");
CREATE INDEX IF NOT EXISTS "vendor_connections_vendor_idx"
  ON "vendor_connections" ("vendor");
CREATE UNIQUE INDEX IF NOT EXISTS "vendor_connections_org_vendor_label_unique_idx"
  ON "vendor_connections" ("organization_id", "vendor", "label");

-- Pricing entries for `connections.token` and `connections.refresh`.
-- `0.0001 USD` per token vend; refresh is free (its cost is amortized into
-- the token vend price). Other connection endpoints are free.
INSERT INTO "service_pricing" ("service_id", "method", "cost", "metadata")
VALUES
  ('connections', 'token', 0.0001,
    '{"description": "Vend short-lived SaaS OAuth access token to the agent"}'::jsonb),
  ('connections', 'refresh', 0,
    '{"description": "Refresh stored vendor token (cost amortized into token vend)"}'::jsonb)
ON CONFLICT ("service_id", "method") DO NOTHING;
