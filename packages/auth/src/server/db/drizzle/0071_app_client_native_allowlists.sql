ALTER TABLE "tenant_app_clients"
  ADD COLUMN IF NOT EXISTS "allowed_bundle_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS "allowed_package_names" text[] DEFAULT '{}'::text[] NOT NULL;
