ALTER TABLE cloud_google_connections ADD COLUMN IF NOT EXISTS send_mail boolean NOT NULL DEFAULT false;
ALTER TABLE cloud_google_authorizations ADD COLUMN IF NOT EXISTS send_mail boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS cloud_google_operations (
  account_id text NOT NULL REFERENCES accounts(key) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  request_hash text NOT NULL,
  provider_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, operation_id)
);

ALTER TABLE cloud_google_connections
  ADD COLUMN IF NOT EXISTS trash_mail boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS write_calendar boolean NOT NULL DEFAULT false;

ALTER TABLE cloud_google_authorizations
  ADD COLUMN IF NOT EXISTS trash_mail boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS write_calendar boolean NOT NULL DEFAULT false;

ALTER TABLE cloud_google_operations
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'send',
  ADD COLUMN IF NOT EXISTS target_version text,
  ADD COLUMN IF NOT EXISTS recovered_by uuid;

CREATE UNIQUE INDEX IF NOT EXISTS cloud_google_message_revision_once
  ON cloud_google_operations (account_id, connection_id, kind, request_hash)
  WHERE kind IN ('trash', 'undo');
