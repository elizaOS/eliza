ALTER TABLE auth_events
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL
    DEFAULT (NOW() + INTERVAL '7 years');

CREATE INDEX IF NOT EXISTS auth_events_expires_at_idx ON auth_events(expires_at);
