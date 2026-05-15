-- Wave C: atomic OAuth intent + event log.
-- Composes with the existing SensitiveRequestDispatchRegistry to deliver
-- OAuth authorization links across channels (DM, owner-app inline, cloud
-- authenticated link, tunnel, public link). Provider-callback routes mark
-- intents as bound/denied and publish to OAuthCallbackBus.
--
-- `provider`, `status`, and `event_name` use SQL CHECK constraints so new
-- providers can be added without ALTER TYPE coordination across deployments.

CREATE TABLE IF NOT EXISTS oauth_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id UUID,

  provider TEXT NOT NULL CHECK (provider IN ('google','discord','linkedin','linear','shopify','calendly')),
  scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  expected_identity_id TEXT,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','bound','denied','expired','canceled')),

  state_token_hash TEXT NOT NULL,
  pkce_verifier_hash TEXT,

  hosted_url TEXT,
  callback_url TEXT,

  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX idx_oauth_intents_state_token_hash ON oauth_intents(state_token_hash);
CREATE INDEX idx_oauth_intents_org_created ON oauth_intents(organization_id, created_at DESC);
CREATE INDEX idx_oauth_intents_status_expires ON oauth_intents(status, expires_at) WHERE status IN ('pending');
CREATE INDEX idx_oauth_intents_agent ON oauth_intents(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_oauth_intents_expected_identity ON oauth_intents(expected_identity_id) WHERE expected_identity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oauth_intent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  oauth_intent_id UUID NOT NULL REFERENCES oauth_intents(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CHECK (event_name IN (
    'oauth.created','oauth.delivered','oauth.callback_received',
    'oauth.bound','oauth.denied','oauth.canceled','oauth.expired',
    'oauth.revoked','callback.dispatched','callback.failed'
  )),
  redacted_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oauth_intent_events_intent ON oauth_intent_events(oauth_intent_id, occurred_at);
