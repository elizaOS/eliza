-- Wave B: unified payment requests table.
-- Lands alongside app_charges, crypto_payments, x402_payment_requests.
-- Wave H will migrate existing rows and decommission the legacy tables.

CREATE TABLE IF NOT EXISTS payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
  app_id UUID REFERENCES apps(id) ON DELETE SET NULL,

  provider TEXT NOT NULL CHECK (provider IN ('stripe','oxapay','x402','wallet_native')),
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  reason TEXT,

  payment_context JSONB NOT NULL DEFAULT '{"kind":"any_payer"}'::jsonb,
  -- shape: {"kind":"any_payer"} | {"kind":"verified_payer","scope":"owner"|"owner_or_linked_identity"} | {"kind":"specific_payer","payerIdentityId":"..."}
  payer_identity_id TEXT,
  payer_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','settled','failed','expired','canceled')),
  hosted_url TEXT,
  callback_url TEXT,
  callback_secret TEXT,

  -- Provider-specific opaque blob (Stripe session id, OxaPay track id, x402 facilitator request id, etc.)
  provider_intent JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Settlement record
  settled_at TIMESTAMPTZ,
  settlement_tx_ref TEXT,
  settlement_proof JSONB,

  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_payment_requests_org_created ON payment_requests(organization_id, created_at DESC);
CREATE INDEX idx_payment_requests_status_expires ON payment_requests(status, expires_at) WHERE status IN ('pending','delivered');
CREATE INDEX idx_payment_requests_provider_intent ON payment_requests USING GIN (provider_intent);
CREATE INDEX idx_payment_requests_agent ON payment_requests(agent_id) WHERE agent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id UUID NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CHECK (event_name IN (
    'payment.created','payment.delivered','payment.viewed','payment.proof_received',
    'payment.settled','payment.failed','payment.canceled','payment.expired',
    'callback.dispatched','callback.failed','webhook.received'
  )),
  redacted_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_request_events_request ON payment_request_events(payment_request_id, occurred_at);
