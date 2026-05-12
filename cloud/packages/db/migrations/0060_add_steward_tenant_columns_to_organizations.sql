BEGIN;

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "steward_tenant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "steward_tenant_api_key" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_steward_tenant_id_unique"
  ON "organizations" ("steward_tenant_id");

COMMIT;
