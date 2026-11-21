ALTER TABLE device_grants ADD COLUMN IF NOT EXISTS scopes jsonb NOT NULL DEFAULT '["cloud:user"]'::jsonb;
