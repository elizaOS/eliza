-- Keep old application revisions safe during a rolling deploy. A writer that
-- predates the attempts table can still mutate the binding lease directly, so
-- the database rejects reuse and materializes exact provider-egress commits.
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
