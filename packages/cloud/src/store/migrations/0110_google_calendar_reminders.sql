CREATE TABLE IF NOT EXISTS cloud_google_calendar_reminders (
  account_id text NOT NULL REFERENCES cloud_google_connections(account_id) ON DELETE CASCADE,
  grant_id uuid NOT NULL REFERENCES cloud_google_connections(id) ON DELETE CASCADE,
  occurrence_id text NOT NULL,
  series_id text,
  provider_version text NOT NULL,
  lead_minutes integer NOT NULL CHECK (lead_minutes IN (60, 1440)),
  fire_at bigint NOT NULL CHECK (fire_at > 0),
  PRIMARY KEY (account_id, grant_id, occurrence_id)
);
