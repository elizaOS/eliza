-- Any deletion of an apps row must terminally revoke every mobile credential
-- minted for that app, not just the row deleted through the two-phase
-- prepareDeleteWithMobileAuthRevocation/finalizeDelete service flow. api_keys
-- ("source_app_id", added in 0278_mobile_auth_source_app) intentionally
-- carries no FK to apps — the column exists to preserve audit attribution
-- after an app is gone, so it cannot cascade-null or cascade-delete the
-- credential row. That means an app row removed by any path OTHER than the
-- app-level service (an ON DELETE CASCADE fired by deleting the owning
-- organization or user, or a raw admin/DB delete) leaves the credential row
-- untouched and still able to authenticate. This trigger is the fail-closed
-- backstop: it fires on every deletion of an apps row, regardless of which
-- code path removed it, and unconditionally deactivates + scrubs the secret
-- material of any api_keys row still pointing at that app.
CREATE OR REPLACE FUNCTION "tombstone_mobile_credentials_on_app_delete"() RETURNS trigger AS $$ BEGIN
  UPDATE "api_keys" SET
    "is_active" = false,
    "deleted_at" = COALESCE("deleted_at", now()),
    "updated_at" = now(),
    "key_ciphertext" = NULL,
    "key_nonce" = NULL,
    "key_auth_tag" = NULL,
    "key_kms_key_id" = NULL,
    "key_kms_key_version" = NULL
  WHERE "source_app_id" = OLD."id"
    AND ("is_active" = true OR "deleted_at" IS NULL);
  RETURN OLD;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "apps_tombstone_mobile_credentials" ON "apps";
--> statement-breakpoint
CREATE TRIGGER "apps_tombstone_mobile_credentials"
BEFORE DELETE ON "apps"
FOR EACH ROW EXECUTE FUNCTION "tombstone_mobile_credentials_on_app_delete"();
