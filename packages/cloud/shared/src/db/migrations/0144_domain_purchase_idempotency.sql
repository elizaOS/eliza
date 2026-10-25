CREATE TABLE IF NOT EXISTS domain_purchase_idempotency (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  domain text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  charge_id uuid,
  charge jsonb,
  cloudflare_registration_id text,
  managed_domain_id uuid,
  response_body jsonb,
  error_code text,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS domain_purchase_idempotency_key_idx
  ON domain_purchase_idempotency(key);
CREATE INDEX IF NOT EXISTS domain_purchase_idempotency_org_domain_idx
  ON domain_purchase_idempotency(organization_id, domain);
CREATE INDEX IF NOT EXISTS domain_purchase_idempotency_expires_idx
  ON domain_purchase_idempotency(expires_at);
CREATE INDEX IF NOT EXISTS domain_purchase_idempotency_status_idx
  ON domain_purchase_idempotency(status);
