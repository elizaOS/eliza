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

-- Keep old application revisions safe during a rolling deploy. A writer that
-- predates this table can still mutate the binding lease directly, so the
-- database must reject reuse of a durably attempted source and materialize an
-- exact attempt whenever that writer commits provider egress.
CREATE OR REPLACE FUNCTION "fence_personal_shared_group_delivery_attempt"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  "existing_lease_token" uuid;
BEGIN
  IF NEW."delivery_lease_source_id" IS NULL OR NEW."delivery_lease_token" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "lease_token"
  INTO "existing_lease_token"
  FROM "personal_shared_group_delivery_attempts"
  WHERE "binding_id" = NEW."id"
    AND "source_message_id" = NEW."delivery_lease_source_id";

  IF "existing_lease_token" IS NOT NULL AND (
    "existing_lease_token" <> NEW."delivery_lease_token"
    OR OLD."delivery_lease_source_id" IS DISTINCT FROM NEW."delivery_lease_source_id"
    OR OLD."delivery_lease_token" IS DISTINCT FROM NEW."delivery_lease_token"
  ) THEN
    RAISE EXCEPTION 'delivery source was already attempted'
      USING ERRCODE = '23505',
        CONSTRAINT = 'personal_shared_group_delivery_attempts_binding_source_uidx';
  END IF;

  IF NEW."delivery_lease_committed_at" IS NOT NULL THEN
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
    ) VALUES (
      NEW."id",
      NEW."platform",
      NEW."project",
      NEW."connector_account_id",
      NEW."provider_chat_id",
      NEW."delivery_lease_source_id",
      NEW."delivery_lease_token",
      'committed',
      NEW."delivery_lease_committed_at"
    )
    ON CONFLICT DO NOTHING;

    SELECT "lease_token"
    INTO "existing_lease_token"
    FROM "personal_shared_group_delivery_attempts"
    WHERE "binding_id" = NEW."id"
      AND "source_message_id" = NEW."delivery_lease_source_id";

    IF "existing_lease_token" IS DISTINCT FROM NEW."delivery_lease_token" THEN
      RAISE EXCEPTION 'delivery source was committed under another lease'
        USING ERRCODE = '23505',
          CONSTRAINT = 'personal_shared_group_delivery_attempts_binding_source_uidx';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "personal_shared_group_delivery_attempt_fence"
  ON "personal_shared_group_bindings";
CREATE TRIGGER "personal_shared_group_delivery_attempt_fence"
BEFORE UPDATE OF
  "delivery_lease_source_id",
  "delivery_lease_token",
  "delivery_lease_committed_at"
ON "personal_shared_group_bindings"
FOR EACH ROW
EXECUTE FUNCTION "fence_personal_shared_group_delivery_attempt"();

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
