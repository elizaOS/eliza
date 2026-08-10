-- Relocate the Cloud identity-approval primitive onto distinct table names.
--
-- Production `public.approval_requests` is owned by plugin-sql's owner-approval
-- queue (columns: state, requested_by, subject_user_id, action, ...). Cloud
-- migration 0122 used the same name for a different shape (organization_id,
-- challenge_kind, status, signature_text, ...). CREATE TABLE IF NOT EXISTS
-- therefore no-oped against the plugin-sql table, Drizzle selects Cloud
-- columns from the wrong relation, and public GET returns 500 before 404
-- (#18074). Never drop or alter the plugin-sql queue.

CREATE TABLE IF NOT EXISTS cloud_approval_requests (
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

  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_cloud_approval_requests_org_created
  ON cloud_approval_requests(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cloud_approval_requests_status_expires
  ON cloud_approval_requests(status, expires_at)
  WHERE status IN ('pending','delivered');
CREATE INDEX IF NOT EXISTS idx_cloud_approval_requests_agent
  ON cloud_approval_requests(agent_id)
  WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cloud_approval_requests_expected_signer
  ON cloud_approval_requests(expected_signer_identity_id)
  WHERE expected_signer_identity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cloud_approval_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_request_id UUID NOT NULL REFERENCES cloud_approval_requests(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL CHECK (event_name IN (
    'approval.created','approval.delivered','approval.viewed',
    'approval.approved','approval.denied','approval.canceled','approval.expired',
    'callback.dispatched','callback.failed'
  )),
  redacted_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cloud_approval_request_events_request
  ON cloud_approval_request_events(approval_request_id, occurred_at);

-- Copy Cloud-shaped rows off the colliding name when a prior environment
-- actually received the Wave D schema (organization_id present). Plugin-sql
-- queues lack that column and are left untouched.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'approval_requests'
      AND column_name = 'organization_id'
  ) THEN
    INSERT INTO cloud_approval_requests (
      id, organization_id, agent_id, user_id,
      challenge_kind, challenge_payload, expected_signer_identity_id,
      status, signature_text, signed_at, expires_at, created_at, updated_at, metadata
    )
    SELECT
      id, organization_id, agent_id, user_id,
      challenge_kind, challenge_payload, expected_signer_identity_id,
      status, signature_text, signed_at, expires_at, created_at, updated_at, metadata
    FROM approval_requests
    ON CONFLICT (id) DO NOTHING;
  END IF;

  IF to_regclass('public.approval_request_events') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'approval_request_events'
        AND column_name = 'approval_request_id'
    )
  THEN
    INSERT INTO cloud_approval_request_events (
      id, approval_request_id, event_name, redacted_payload, occurred_at
    )
    SELECT
      e.id, e.approval_request_id, e.event_name, e.redacted_payload, e.occurred_at
    FROM approval_request_events e
    WHERE EXISTS (
      SELECT 1
      FROM cloud_approval_requests c
      WHERE c.id = e.approval_request_id
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
END
$$;

-- Fail closed unless the Cloud-owned relation has the required catalog shape.
-- Journal presence / to_regclass alone is insufficient after the name collision.
DO $$
DECLARE
  missing text[];
BEGIN
  SELECT coalesce(array_agg(required.column_name ORDER BY required.column_name), ARRAY[]::text[])
  INTO missing
  FROM (
    VALUES
      ('organization_id'),
      ('user_id'),
      ('challenge_kind'),
      ('challenge_payload'),
      ('expected_signer_identity_id'),
      ('status'),
      ('signature_text'),
      ('signed_at'),
      ('metadata')
  ) AS required(column_name)
  LEFT JOIN information_schema.columns catalog
    ON catalog.table_schema = 'public'
    AND catalog.table_name = 'cloud_approval_requests'
    AND catalog.column_name = required.column_name
  WHERE catalog.column_name IS NULL;

  IF to_regclass('public.cloud_approval_requests') IS NULL
    OR cardinality(missing) > 0
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format(
        'cloud_approval_requests catalog mismatch: missing columns [%s]',
        array_to_string(missing, ', ')
      );
  END IF;

  IF to_regclass('public.cloud_approval_request_events') IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'cloud_approval_request_events catalog mismatch: relation missing';
  END IF;
END
$$;
