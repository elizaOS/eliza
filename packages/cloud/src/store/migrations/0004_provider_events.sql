CREATE TABLE provider_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  livemode boolean NOT NULL,
  payload jsonb,
  payload_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('Pending', 'Leased', 'Done', 'DeadLettered')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at bigint NOT NULL,
  lease_until bigint,
  claim jsonb NOT NULL,
  last_error_code text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK ((state = 'Done') = (payload IS NULL))
);

CREATE INDEX provider_events_due ON provider_events (state, next_attempt_at, created_at, id);
