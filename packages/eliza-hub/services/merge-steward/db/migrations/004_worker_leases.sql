-- Durable merge worker lease.
--
-- This keeps multiple steward replicas from auto-claiming merge work at the
-- same time while still allowing fast failover when a worker stops heartbeating.

BEGIN;

CREATE TABLE IF NOT EXISTS steward_worker_leases (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'released', 'expired', 'cancelled')
  ),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  renewed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  released_at timestamptz,
  release_reason text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS steward_worker_leases_active_idx
  ON steward_worker_leases (status, expires_at ASC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS steward_worker_leases_owner_idx
  ON steward_worker_leases (owner_id, status, updated_at DESC);

COMMIT;
