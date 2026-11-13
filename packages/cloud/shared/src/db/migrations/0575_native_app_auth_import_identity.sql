ALTER TABLE "mobile_app_auth_registry_migrations"
  ADD COLUMN IF NOT EXISTS "import_version" integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "schema_version" integer NOT NULL DEFAULT 574,
  ADD COLUMN IF NOT EXISTS "cluster_sha256" text,
  ADD COLUMN IF NOT EXISTS "authority_sha256" text;
