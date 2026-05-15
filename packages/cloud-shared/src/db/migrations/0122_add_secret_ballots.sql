-- Wave G: secret ballots — M-of-N voting primitive (v1 plaintext server-side).
--
-- "Agent collects N secret votes from a fixed participant set; reveals only if
-- the M-of-N threshold is reached." Each participant receives a one-time
-- scoped token; their submission is recorded against a sha256-hashed token.
--
-- v1 stores ballot values as base64-encoded plaintext in `value_ciphertext`.
-- Wave H+ will swap server-side counting for Shamir-shared shares stored in
-- the same column without a schema migration.

CREATE TYPE "secret_ballot_status" AS ENUM (
  'open',
  'tallied',
  'expired',
  'canceled'
);

CREATE TYPE "secret_ballot_event_name" AS ENUM (
  'ballot.created',
  'ballot.distributed',
  'ballot.vote_recorded',
  'ballot.vote_rejected',
  'ballot.tallied',
  'ballot.expired',
  'ballot.canceled'
);

CREATE TABLE IF NOT EXISTS "secret_ballots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  -- agent_id is informational; agents table lives in the elizaOS plugin-sql
  -- schema set, so no in-cloud foreign key.
  "agent_id" uuid,
  "purpose" text NOT NULL,
  "participants" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "threshold" integer NOT NULL,
  "status" "secret_ballot_status" NOT NULL DEFAULT 'open',
  "tally_result" jsonb,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "secret_ballots_threshold_positive" CHECK ("threshold" >= 1)
);

CREATE INDEX "secret_ballots_org_created_idx"
  ON "secret_ballots" ("organization_id", "created_at" DESC);

CREATE INDEX "secret_ballots_status_expires_idx"
  ON "secret_ballots" ("status", "expires_at")
  WHERE "status" = 'open';

CREATE INDEX "secret_ballots_agent_idx"
  ON "secret_ballots" ("agent_id")
  WHERE "agent_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "secret_ballot_votes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ballot_id" uuid NOT NULL REFERENCES "secret_ballots"("id") ON DELETE cascade,
  "participant_token_hash" text NOT NULL,
  "participant_identity_id" text NOT NULL,
  "value_ciphertext" text NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "secret_ballot_votes_ballot_identity_unique"
  ON "secret_ballot_votes" ("ballot_id", "participant_identity_id");

CREATE UNIQUE INDEX "secret_ballot_votes_ballot_token_unique"
  ON "secret_ballot_votes" ("ballot_id", "participant_token_hash");

CREATE INDEX "secret_ballot_votes_ballot_idx"
  ON "secret_ballot_votes" ("ballot_id");

CREATE TABLE IF NOT EXISTS "secret_ballot_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "ballot_id" uuid NOT NULL REFERENCES "secret_ballots"("id") ON DELETE cascade,
  "event_name" "secret_ballot_event_name" NOT NULL,
  "redacted_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "occurred_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "secret_ballot_events_ballot_occurred_idx"
  ON "secret_ballot_events" ("ballot_id", "occurred_at");
