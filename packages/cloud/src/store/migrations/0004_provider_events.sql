CREATE TABLE provider_events (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  phase text NOT NULL CHECK (phase IN ('Pending', 'Leased', 'Done', 'DeadLettered')),
  type text NOT NULL,
  livemode boolean NOT NULL,
  payload jsonb,
  payload_digest text NOT NULL,
  attempts integer NOT NULL CHECK (attempts >= 0),
  next_attempt_at bigint NOT NULL,
  lease_until bigint,
  last_error_code text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK ((phase = 'Done') = (payload IS NULL))
);

CREATE INDEX provider_events_due ON provider_events (phase, next_attempt_at, created_at, key);
