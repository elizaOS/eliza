ALTER TABLE google_connections
  ADD COLUMN IF NOT EXISTS granted_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ALTER COLUMN subject SET DEFAULT '',
  ALTER COLUMN email SET DEFAULT '',
  ALTER COLUMN linked_at DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS google_connections_status_check,
  DROP CONSTRAINT IF EXISTS google_connections_check,
  DROP CONSTRAINT IF EXISTS google_connections_organization_id_subject_key;

UPDATE google_connections
SET granted_scopes = state->'scopes'
WHERE jsonb_typeof(state->'tokens') = 'string'
  AND jsonb_typeof(state->'scopes') = 'array'
  AND NOT jsonb_path_exists(state->'scopes', '$[*] ? (@.type() != "string")');

UPDATE google_connections
SET status = 'Errored'
WHERE status = 'Error' OR (status = 'Pending' AND tokens IS NOT NULL);

ALTER TABLE google_connections
  ADD CONSTRAINT google_connections_status_check CHECK (status IN ('Pending', 'Active', 'Expired', 'Revoked', 'Errored')),
  ADD CONSTRAINT google_connections_check CHECK ((status IN ('Pending', 'Revoked')) <= (tokens IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS google_connections_by_subject ON google_connections (organization_id, subject) WHERE subject <> '';
