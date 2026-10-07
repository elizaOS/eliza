-- The Network: minimal invite-gated membership and SMS consent tables.
-- Rides the canonical Cloud migration ledger in its own Postgres schema, the
-- same way 0206_shared_todos.sql adds "todos". Nothing in "public" changes, so
-- Eliza behaviour is unaffected. Idempotent: every statement can be re-run.

CREATE SCHEMA IF NOT EXISTS "network";

-- One row per person in The Network. `cloud_user_id` / `organization_id` are
-- filled only after an accepted invite lets the inbound route create or link
-- the Cloud account; until then the member exists only here.
CREATE TABLE IF NOT EXISTS "network"."members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "phone_e164" text NOT NULL,
  "cloud_user_id" uuid,
  "organization_id" uuid,
  "first_name" text,
  "city" text,
  "state" text DEFAULT 'open' NOT NULL,
  -- Start of a scheduled state window (future travel); NULL = effective now.
  "state_from" timestamp with time zone,
  "paused_until" timestamp with time zone,
  -- Shareable profile facets only; private facets never live in this column.
  "facets" text[] DEFAULT '{}'::text[] NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "network_members_phone_e164_check"
    CHECK ("phone_e164" ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT "network_members_state_check"
    CHECK ("state" IN ('open', 'busy', 'traveling', 'paused', 'removed')),
  CONSTRAINT "network_members_cloud_account_pair_check"
    CHECK (("cloud_user_id" IS NULL) = ("organization_id" IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "network_members_phone_e164_unique"
  ON "network"."members" ("phone_e164");
CREATE UNIQUE INDEX IF NOT EXISTS "network_members_cloud_user_id_unique"
  ON "network"."members" ("cloud_user_id")
  WHERE "cloud_user_id" IS NOT NULL;

-- Idempotent member state changes (SET_STATE). The bigserial id is the
-- effect receipt's commit id; the idempotency key makes replays a no-op.
CREATE TABLE IF NOT EXISTS "network"."member_events" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "member_id" uuid NOT NULL
    REFERENCES "network"."members" ("id") ON DELETE CASCADE,
  "idempotency_key" text NOT NULL,
  "type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "network_member_events_idempotency_key_unique"
  ON "network"."member_events" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "network_member_events_member_created_idx"
  ON "network"."member_events" ("member_id", "created_at" DESC);

-- Post-turn signals detected in a member's own messages (NETWORK_SIGNALS).
CREATE TABLE IF NOT EXISTS "network"."member_signals" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "member_id" uuid NOT NULL
    REFERENCES "network"."members" ("id") ON DELETE CASCADE,
  "message_id" text NOT NULL,
  "kind" text NOT NULL,
  "evidence" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "network_member_signals_kind_check"
    CHECK ("kind" IN ('opt_out', 'travel', 'safety_concern'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "network_member_signals_message_kind_unique"
  ON "network"."member_signals" ("member_id", "message_id", "kind");

-- Invites are addressed to a phone number. Only the token hash is stored. The
-- inbound gate admits a phone with a live (pending, unexpired) or accepted
-- invite, or a non-removed member; the first admitted message accepts the
-- invite and links the member to its Cloud account.
CREATE TABLE IF NOT EXISTS "network"."invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "phone_e164" text NOT NULL,
  "token_hash" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "invited_by_member_id" uuid
    REFERENCES "network"."members" ("id") ON DELETE SET NULL,
  "accepted_member_id" uuid
    REFERENCES "network"."members" ("id") ON DELETE SET NULL,
  "expires_at" timestamp with time zone,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "network_invites_phone_e164_check"
    CHECK ("phone_e164" ~ '^\+[1-9][0-9]{6,14}$'),
  CONSTRAINT "network_invites_status_check"
    CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired')),
  CONSTRAINT "network_invites_accepted_at_check"
    CHECK (("status" = 'accepted') = ("accepted_at" IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "network_invites_token_hash_unique"
  ON "network"."invites" ("token_hash");
CREATE INDEX IF NOT EXISTS "network_invites_phone_status_idx"
  ON "network"."invites" ("phone_e164", "status");

-- Append-only consent ledger (STOP / START / HELP keywords, invite acceptance,
-- admin changes). The current state for an address is its latest row. A
-- provider message id makes keyword replays idempotent.
CREATE TABLE IF NOT EXISTS "network"."consent_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "channel" text NOT NULL,
  "address" text NOT NULL,
  "state" text NOT NULL,
  "source" text NOT NULL,
  "provider_message_id" text,
  "wording" text,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "network_consent_ledger_channel_check"
    CHECK ("channel" IN ('twilio', 'blooio', 'telegram', 'whatsapp', 'web')),
  CONSTRAINT "network_consent_ledger_state_check"
    CHECK ("state" IN ('opted_in', 'opted_out')),
  CONSTRAINT "network_consent_ledger_source_check"
    CHECK (length("source") BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS "network_consent_ledger_address_recorded_idx"
  ON "network"."consent_ledger" ("address", "recorded_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "network_consent_ledger_provider_message_unique"
  ON "network"."consent_ledger" ("channel", "provider_message_id")
  WHERE "provider_message_id" IS NOT NULL;

CREATE OR REPLACE FUNCTION "network"."consent_ledger_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'network.consent_ledger is append-only';
END;
$$;

DROP TRIGGER IF EXISTS "network_consent_ledger_append_only"
  ON "network"."consent_ledger";
CREATE TRIGGER "network_consent_ledger_append_only"
  BEFORE UPDATE OR DELETE ON "network"."consent_ledger"
  FOR EACH ROW EXECUTE FUNCTION "network"."consent_ledger_append_only"();
