CREATE TABLE code_challenges (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  method text NOT NULL CHECK (method IN ('email', 'sms')),
  purpose_key text NOT NULL,
  user_id text,
  client_id text NOT NULL,
  destination_digest text NOT NULL,
  code_digest text NOT NULL,
  code_challenge text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('unsent', 'open', 'locked', 'consumed', 'superseded', 'expired')),
  sent_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  CHECK ((purpose_key = 'sign-in') = (user_id IS NULL))
);
CREATE UNIQUE INDEX code_challenges_one_open ON code_challenges (method, purpose_key, destination_digest) WHERE phase = 'open';
CREATE INDEX code_challenges_destination ON code_challenges (method, purpose_key, destination_digest, sent_at DESC);
CREATE INDEX code_challenges_expiry ON code_challenges (expires_at);
