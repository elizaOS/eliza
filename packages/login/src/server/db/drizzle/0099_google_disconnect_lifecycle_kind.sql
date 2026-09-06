-- Permit encrypted, durable Google disconnect revocation handles. This is a
-- separate migration because 0098 is already deployed.
ALTER TABLE "provider_google_credential_lifecycles"
  DROP CONSTRAINT "provider_google_lifecycle_kind_check";
--> statement-breakpoint
ALTER TABLE "provider_google_credential_lifecycles"
  ADD CONSTRAINT "provider_google_lifecycle_kind_check"
  CHECK ("kind" IN ('connect_exchange', 'refresh_rotation', 'disconnect_revoke'));
