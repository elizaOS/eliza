ALTER TABLE provider_events ADD COLUMN revivals integer NOT NULL DEFAULT 0 CHECK (revivals >= 0);
