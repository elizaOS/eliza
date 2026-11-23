ALTER TABLE sessions
  ADD COLUMN kind text NOT NULL DEFAULT 'browser' CHECK (kind IN ('browser', 'device_lease')),
  ADD COLUMN grant_key text,
  ADD COLUMN offered_access_digest text UNIQUE,
  ADD COLUMN offered_refresh_digest text UNIQUE,
  ADD CONSTRAINT sessions_lease_grant CHECK ((kind = 'device_lease') = (grant_key IS NOT NULL)),
  ADD CONSTRAINT sessions_offer_pair CHECK ((offered_access_digest IS NULL) = (offered_refresh_digest IS NULL));
CREATE INDEX sessions_grant ON sessions (grant_key) WHERE grant_key IS NOT NULL;
UPDATE sessions SET state = state || '{"kind": {"tag": "BrowserFamily"}, "rotation": {"tag": "Settled"}}'::jsonb WHERE NOT state ? 'kind';

ALTER TABLE device_grants ADD COLUMN sealed_lease text;
