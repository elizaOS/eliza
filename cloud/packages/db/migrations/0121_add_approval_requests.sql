-- Wave D: approval requests for identity verification flows.
-- Atomic primitives for "approve a login" / "verify this identity":
-- agent issues challenge -> delivers to user -> awaits signed response ->
-- validates signature -> binds identity to session.

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id UUID,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  challenge_kind TEXT NOT NULL CHECK (challenge_kind IN ('login','signature','generic')),
  challenge_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  expected_signer_identity_id TEXT,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','approved','denied','expired','canceled')),

  signature_text TEXT,
  signed_at TIMESTAMPTZ,

  hosted_url TEXT,
  callback_url TEXT,
  callback_secret TEXT,

  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_approval_requests_org_created ON approval_requests(organization_id, created_at DESC);
CREATE INDEX idx_approval_requests_status_expires ON approval_requests(status, expires_at) WHERE status IN ('pending','delivered');
CREATE INDEX idx_approval_requests_agent ON approval_requests(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX idx_approval_requests_signer ON approval_requests(expected_signer_identity_id) WHERE expected_signer_identity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS approval_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CHECK (event_name IN (
    'approval.created','approval.delivered','approval.viewed',
    'approval.approved','approval.denied','approval.canceled','approval.expired',
    'callback.dispatched','callback.failed','signature.verified','signature.rejected'
  )),
  redacted_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_approval_request_events_request ON approval_request_events(approval_request_id, occurred_at);
