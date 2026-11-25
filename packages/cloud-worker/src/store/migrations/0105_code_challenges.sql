CREATE TABLE IF NOT EXISTS cloud_code_challenges (
  provider text NOT NULL CHECK (provider IN ('email', 'sms')),
  destination text NOT NULL,
  challenge text NOT NULL,
  code_hash text,
  expires_at timestamptz NOT NULL,
  tries integer NOT NULL CHECK (tries BETWEEN 0 AND 5),
  consumed boolean NOT NULL DEFAULT false,
  PRIMARY KEY (provider, destination),
  CHECK ((provider = 'email') = (code_hash IS NOT NULL))
);
