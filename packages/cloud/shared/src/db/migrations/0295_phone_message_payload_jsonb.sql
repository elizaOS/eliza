-- Reserved after the in-flight subscription series (0275-0286, rebased as 0283-0294).
-- Convert the five semantic phone payload columns from legacy TEXT to canonical JSONB.
-- Drizzle's PostgreSQL migrator executes each migration in one transaction, so
-- malformed JSON or a failed shape constraint rolls back every column change.
-- Capture message tenancy on the historical row before any phone-number mapping
-- can be reassigned; current phone ownership must never grant access to old logs.
ALTER TABLE "phone_message_log"
  ADD COLUMN IF NOT EXISTS "organization_id" uuid;
UPDATE "phone_message_log" AS "message"
SET "organization_id" = "owner"."organization_id"
FROM "agent_phone_numbers" AS "owner"
WHERE "message"."organization_id" IS NULL
  AND "owner"."id" = "message"."phone_number_id";
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "phone_message_log" WHERE "organization_id" IS NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = 'phone message tenant backfill failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "phone_message_log" AS "message"
    CROSS JOIN LATERAL (
      VALUES
        (to_jsonb("message")->>'message_body_storage', to_jsonb("message")->>'message_body_key'),
        (to_jsonb("message")->>'media_urls_storage', to_jsonb("message")->>'media_urls_key'),
        (to_jsonb("message")->>'agent_response_storage', to_jsonb("message")->>'agent_response_key'),
        (to_jsonb("message")->>'metadata_storage', to_jsonb("message")->>'metadata_key')
    ) AS "payload"("storage", "key")
    WHERE "payload"."storage" = 'r2'
      AND (
        "payload"."key" IS NULL
        OR strpos(
          "payload"."key",
          'phone-message-payloads/' || "message"."organization_id"::text || '/'
        ) <> 1
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'phone message object tenant audit failed';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "public"."enforce_phone_message_log_owner"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  "current_owner" uuid;
BEGIN
  SELECT "organization_id" INTO "current_owner"
  FROM "public"."agent_phone_numbers"
  WHERE "id" = NEW."phone_number_id";

  IF "current_owner" IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'phone message owner was not found';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."organization_id" IS DISTINCT FROM OLD."organization_id" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'phone message tenant is immutable';
  END IF;
  IF NEW."organization_id" IS NULL THEN
    NEW."organization_id" := "current_owner";
  ELSIF NEW."organization_id" IS DISTINCT FROM "current_owner" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'phone message tenant does not match its phone owner';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "phone_message_log_owner_guard" ON "phone_message_log";
CREATE TRIGGER "phone_message_log_owner_guard"
  BEFORE INSERT OR UPDATE OF "phone_number_id", "organization_id"
  ON "phone_message_log"
  FOR EACH ROW EXECUTE FUNCTION "public"."enforce_phone_message_log_owner"();

CREATE UNIQUE INDEX IF NOT EXISTS "agent_phone_numbers_id_organization_idx"
  ON "agent_phone_numbers" USING btree ("id", "organization_id");
ALTER TABLE "phone_message_log"
  ALTER COLUMN "organization_id" SET NOT NULL,
  DROP CONSTRAINT IF EXISTS "phone_message_log_organization_id_organizations_id_fk",
  DROP CONSTRAINT IF EXISTS "phone_message_log_phone_owner_fk";
ALTER TABLE "phone_message_log" ADD CONSTRAINT
  "phone_message_log_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
ALTER TABLE "phone_message_log" ADD CONSTRAINT
  "phone_message_log_phone_owner_fk"
  FOREIGN KEY ("phone_number_id", "organization_id")
  REFERENCES "agent_phone_numbers"("id", "organization_id") ON DELETE cascade;
CREATE INDEX IF NOT EXISTS "phone_message_log_organization_idx"
  ON "phone_message_log" USING btree ("organization_id");
--> statement-breakpoint
ALTER TABLE "agent_phone_numbers"
  DROP CONSTRAINT IF EXISTS "agent_phone_numbers_metadata_object_check";
ALTER TABLE "phone_message_log"
  DROP CONSTRAINT IF EXISTS "phone_message_log_media_urls_array_check",
  DROP CONSTRAINT IF EXISTS "phone_message_log_metadata_object_check";
ALTER TABLE "agent_phone_contacts"
  DROP CONSTRAINT IF EXISTS "agent_phone_contacts_metadata_object_check";
ALTER TABLE "phone_gateway_devices"
  DROP CONSTRAINT IF EXISTS "phone_gateway_devices_metadata_object_check";
--> statement-breakpoint
ALTER TABLE "agent_phone_numbers" ALTER COLUMN "metadata" DROP DEFAULT;
ALTER TABLE "phone_message_log" ALTER COLUMN "metadata" DROP DEFAULT;
ALTER TABLE "agent_phone_contacts" ALTER COLUMN "metadata" DROP DEFAULT;
ALTER TABLE "phone_gateway_devices" ALTER COLUMN "metadata" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "agent_phone_numbers"
  ALTER COLUMN "metadata" TYPE jsonb USING "metadata"::jsonb;
ALTER TABLE "phone_message_log"
  ALTER COLUMN "media_urls" TYPE jsonb USING "media_urls"::jsonb,
  ALTER COLUMN "metadata" TYPE jsonb USING "metadata"::jsonb;
ALTER TABLE "agent_phone_contacts"
  ALTER COLUMN "metadata" TYPE jsonb USING "metadata"::jsonb;
ALTER TABLE "phone_gateway_devices"
  ALTER COLUMN "metadata" TYPE jsonb USING "metadata"::jsonb;
--> statement-breakpoint
ALTER TABLE "agent_phone_numbers" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb;
ALTER TABLE "phone_message_log" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb;
ALTER TABLE "agent_phone_contacts" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb;
ALTER TABLE "phone_gateway_devices" ALTER COLUMN "metadata" SET DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "agent_phone_numbers" ADD CONSTRAINT
  "agent_phone_numbers_metadata_object_check"
  CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object');
ALTER TABLE "phone_message_log" ADD CONSTRAINT
  "phone_message_log_media_urls_array_check"
  CHECK ("media_urls" IS NULL OR (
    jsonb_typeof("media_urls") = 'array'
    AND NOT jsonb_path_exists("media_urls", 'strict $[*] ? (@.type() != "string")')
  ));
ALTER TABLE "phone_message_log" ADD CONSTRAINT
  "phone_message_log_metadata_object_check"
  CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object');
ALTER TABLE "agent_phone_contacts" ADD CONSTRAINT
  "agent_phone_contacts_metadata_object_check"
  CHECK (jsonb_typeof("metadata") = 'object');
ALTER TABLE "phone_gateway_devices" ADD CONSTRAINT
  "phone_gateway_devices_metadata_object_check"
  CHECK (jsonb_typeof("metadata") = 'object');
