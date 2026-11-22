ALTER TABLE device_grants ADD COLUMN IF NOT EXISTS renewed_from text;
ALTER TABLE device_grants ADD COLUMN IF NOT EXISTS sign_in_at bigint;
UPDATE device_grants SET sign_in_at = issued_at WHERE sign_in_at IS NULL;
CREATE INDEX IF NOT EXISTS device_grants_renewed_from ON device_grants (renewed_from) WHERE renewed_from IS NOT NULL;
