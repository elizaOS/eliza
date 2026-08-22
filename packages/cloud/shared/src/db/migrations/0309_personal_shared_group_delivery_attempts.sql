CREATE TABLE IF NOT EXISTS "personal_shared_group_delivery_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "binding_id" uuid NOT NULL REFERENCES "personal_shared_group_bindings"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "project" text NOT NULL,
  "connector_account_id" text NOT NULL,
  "provider_chat_id" text NOT NULL,
  "source_message_id" text NOT NULL,
  "lease_token" uuid NOT NULL,
  "state" text NOT NULL,
  "committed_at" timestamptz NOT NULL,
  "uncertain_at" timestamptz,
  "reconciled_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "personal_shared_group_delivery_attempts_platform_check" CHECK ("platform" IN ('telegram', 'blooio')),
  CONSTRAINT "personal_shared_group_delivery_attempts_state_check" CHECK ("state" IN ('committed', 'uncertain', 'reconciled')),
  CONSTRAINT "personal_shared_group_delivery_attempts_state_timestamps_check" CHECK (
    ("state" = 'committed' AND "uncertain_at" IS NULL AND "reconciled_at" IS NULL)
    OR ("state" = 'uncertain' AND "uncertain_at" IS NOT NULL AND "reconciled_at" IS NULL)
    OR ("state" = 'reconciled' AND "reconciled_at" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "personal_shared_group_delivery_attempts_binding_source_uidx"
  ON "personal_shared_group_delivery_attempts" ("binding_id", "source_message_id");
CREATE UNIQUE INDEX IF NOT EXISTS "personal_shared_group_delivery_attempts_binding_token_uidx"
  ON "personal_shared_group_delivery_attempts" ("binding_id", "lease_token");
CREATE INDEX IF NOT EXISTS "personal_shared_group_delivery_attempts_state_committed_idx"
  ON "personal_shared_group_delivery_attempts" ("state", "committed_at");

-- Preserve every in-flight committed authorization introduced by migration 0304.
-- Its delivery result is unknown until a provider receipt reconciles it.
INSERT INTO "personal_shared_group_delivery_attempts" (
  "binding_id",
  "platform",
  "project",
  "connector_account_id",
  "provider_chat_id",
  "source_message_id",
  "lease_token",
  "state",
  "committed_at"
)
SELECT
  "id",
  "platform",
  "project",
  "connector_account_id",
  "provider_chat_id",
  "delivery_lease_source_id",
  "delivery_lease_token",
  'committed',
  "delivery_lease_committed_at"
FROM "personal_shared_group_bindings"
WHERE "delivery_lease_source_id" IS NOT NULL
  AND "delivery_lease_token" IS NOT NULL
  AND "delivery_lease_committed_at" IS NOT NULL
ON CONFLICT DO NOTHING;
