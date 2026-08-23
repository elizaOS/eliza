-- Durable admission ledger for pooled-key vision descriptions of inbound
-- Personal Shared media: one idempotency record per connector message id and
-- atomic per-day image counters for the sending account and the connector.

CREATE TABLE IF NOT EXISTS personal_shared_inbound_media_descriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform text NOT NULL CHECK (platform IN ('blooio')),
  project text NOT NULL,
  connector_account_id text NOT NULL,
  source_message_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_digest text NOT NULL,
  image_count integer NOT NULL CHECK (image_count > 0),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'described', 'failed')),
  claim_token uuid NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
  description text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT personal_shared_inbound_media_descriptions_terminal_shape_check CHECK (
    (
      state = 'pending'
      AND description IS NULL
      AND failure_reason IS NULL
      AND completed_at IS NULL
    ) OR (
      state = 'described'
      AND description IS NOT NULL
      AND failure_reason IS NULL
      AND completed_at IS NOT NULL
    ) OR (
      state = 'failed'
      AND description IS NULL
      AND failure_reason IS NOT NULL
      AND completed_at IS NOT NULL
    )
  )
);

COMMENT ON TABLE personal_shared_inbound_media_descriptions IS
  'Enrichment idempotency record: at most one pooled-key vision claim per connector message id. A redelivery reuses a described row, skips a failed row, and may only reclaim a pending row after its lease expired.';

CREATE UNIQUE INDEX IF NOT EXISTS personal_shared_inbound_media_descriptions_source_uidx
  ON personal_shared_inbound_media_descriptions
  (platform, project, connector_account_id, source_message_id);
CREATE INDEX IF NOT EXISTS personal_shared_inbound_media_descriptions_org_created_idx
  ON personal_shared_inbound_media_descriptions (organization_id, created_at);

CREATE TABLE IF NOT EXISTS personal_shared_inbound_media_quotas (
  scope text NOT NULL CHECK (scope IN ('sender', 'connector')),
  scope_key text NOT NULL,
  day date NOT NULL,
  image_count integer NOT NULL CHECK (image_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_shared_inbound_media_quotas_pkey PRIMARY KEY (scope, scope_key, day)
);

COMMENT ON TABLE personal_shared_inbound_media_quotas IS
  'UTC-day image counters consumed atomically (conditional upsert) before any pooled-key vision call; the ceilings live in the Worker bindings, the used totals live here.';
