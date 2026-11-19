ALTER TABLE subscriptions
  ADD COLUMN period_start bigint NOT NULL DEFAULT 0,
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN pending_plan_key text,
  ADD COLUMN dunning_started_at bigint,
  ADD COLUMN dunning_ends_at bigint,
  ADD COLUMN policy_generation bigint NOT NULL DEFAULT 0 CHECK (policy_generation >= 0),
  ADD COLUMN live_command text,
  ADD CONSTRAINT subscriptions_dunning_window CHECK ((dunning_started_at IS NULL) = (dunning_ends_at IS NULL) AND (dunning_started_at IS NULL OR dunning_started_at < dunning_ends_at));
CREATE INDEX subscriptions_dunning_due ON subscriptions (dunning_ends_at) WHERE status = 'dunning';

CREATE TABLE quotes (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations (id),
  command_kind text NOT NULL CHECK (command_kind IN ('upgrade', 'downgrade')),
  target_plan_key text NOT NULL,
  proration_date bigint NOT NULL,
  due_now_cents bigint NOT NULL CHECK (due_now_cents >= 0),
  recurring_cents bigint NOT NULL CHECK (recurring_cents >= 0),
  adjustment_micros bigint NOT NULL CHECK (adjustment_micros >= 0),
  expires_at bigint NOT NULL
);
CREATE INDEX quotes_owner ON quotes (organization_id, expires_at);

CREATE TABLE grant_codes (
  key text PRIMARY KEY,
  state jsonb NOT NULL,
  revision bigint NOT NULL,
  family text NOT NULL,
  plan_key text NOT NULL,
  disabled boolean NOT NULL DEFAULT false,
  updated_at bigint NOT NULL
);

ALTER TABLE grants ALTER COLUMN effective_until DROP NOT NULL;
ALTER TABLE grants DROP CONSTRAINT grants_check;
ALTER TABLE grants
  ADD CONSTRAINT grants_window CHECK (effective_until IS NULL OR effective_from < effective_until),
  ADD COLUMN code_key text REFERENCES grant_codes (key),
  ADD COLUMN idempotency_key text,
  ADD COLUMN revoked_at bigint,
  ADD CONSTRAINT grants_idempotency UNIQUE (organization_id, idempotency_key);
