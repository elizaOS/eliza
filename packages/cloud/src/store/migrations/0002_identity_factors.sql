CREATE TABLE second_factors (
  key text PRIMARY KEY REFERENCES accounts (key),
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  totp_seed text,
  sms_phone text,
  pending_phone text,
  setup_digest text,
  challenge_id text UNIQUE,
  challenge_client_id text,
  challenge_digest text,
  step_up_session text,
  step_up_digest text
);
