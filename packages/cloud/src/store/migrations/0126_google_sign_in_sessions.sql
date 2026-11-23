ALTER TABLE google_connections
  DROP CONSTRAINT IF EXISTS google_connections_status_check,
  ADD CONSTRAINT google_connections_status_check CHECK (status IN ('Pending', 'Unconfirmed', 'Active', 'Expired', 'Revoked', 'Errored'));

ALTER TABLE google_connect_states
  ADD COLUMN IF NOT EXISTS session_id text,
  ADD COLUMN IF NOT EXISTS outcome text CHECK (outcome IN ('allowed', 'cancelled', 'refused')),
  ADD COLUMN IF NOT EXISTS connection_id text;

CREATE UNIQUE INDEX IF NOT EXISTS google_connect_states_by_session ON google_connect_states (session_id) WHERE session_id IS NOT NULL;
