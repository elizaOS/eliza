ALTER TABLE "provider_x_credential_lifecycles"
  ADD COLUMN "disabled_routes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT "provider_x_lifecycle_disabled_routes_array_check"
    CHECK (jsonb_typeof("disabled_routes") = 'array');
