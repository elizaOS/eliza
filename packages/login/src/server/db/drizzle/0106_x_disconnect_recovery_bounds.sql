ALTER TABLE "provider_x_credential_lifecycles"
  DROP CONSTRAINT "provider_x_lifecycle_kind_check",
  DROP CONSTRAINT "provider_x_lifecycle_refresh_binding_check",
  ADD CONSTRAINT "provider_x_lifecycle_kind_check"
    CHECK ("kind" IN ('connect_exchange', 'refresh_rotation', 'disconnect_revoke')),
  ADD CONSTRAINT "provider_x_lifecycle_refresh_binding_check"
    CHECK ("kind" = 'connect_exchange' OR ("provider_account_id" IS NOT NULL AND "expected_account_revision" IS NOT NULL));
