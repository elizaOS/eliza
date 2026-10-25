-- Durable first-party mobile Authorization Code + PKCE grants. The API key is
-- created inactive on exchange and activated only after the native client
-- proves it durably stored the secret with an explicit acknowledgement.
CREATE TABLE IF NOT EXISTS mobile_app_auth_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL,
  app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('staging','production')),
  redirect_uri TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL CHECK (code_challenge_method = 'S256'),
  scopes JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','exchanged','acknowledged')),
  credential_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  exchanged_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_app_auth_grants_code_hash
  ON mobile_app_auth_grants(code_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mobile_app_auth_grants_expires_status
  ON mobile_app_auth_grants(expires_at, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mobile_app_auth_grants_credential
  ON mobile_app_auth_grants(credential_id)
  WHERE credential_id IS NOT NULL;
