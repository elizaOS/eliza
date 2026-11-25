ALTER TABLE google_connect_states ADD COLUMN expected_email_digest text
  CHECK (expected_email_digest ~ '^[0-9a-f]{64}$');
