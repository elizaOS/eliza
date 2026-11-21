ALTER TABLE google_connect_states
  ADD COLUMN IF NOT EXISTS connection_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS client_id text,
  ADD COLUMN IF NOT EXISTS app_state text;
