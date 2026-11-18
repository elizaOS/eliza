ALTER TABLE device_grants ADD COLUMN IF NOT EXISTS code_challenge text;
ALTER TABLE device_grants ADD COLUMN IF NOT EXISTS sealed_copy text;
CREATE INDEX IF NOT EXISTS device_grants_live ON device_grants (user_id, key_expires_at) WHERE phase = 'active';
