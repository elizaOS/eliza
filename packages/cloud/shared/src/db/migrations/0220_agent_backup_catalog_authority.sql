-- Per-agent monotone catalogue authority survives compute deletion and node loss.
CREATE TABLE IF NOT EXISTS "agent_backup_catalog_authorities" (
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "agent_id" uuid NOT NULL,
  "catalog_revision" bigint NOT NULL DEFAULT 0,
  "restore_generation" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("organization_id", "agent_id"),
  CONSTRAINT "agent_backup_catalog_authorities_counters_check" CHECK (
    "catalog_revision" >= 0 AND "restore_generation" >= 0
  )
);

INSERT INTO "agent_backup_catalog_authorities" (
  "organization_id", "agent_id", "catalog_revision", "restore_generation", "updated_at"
)
SELECT
  backup."catalog_organization_id",
  backup."catalog_agent_id",
  MAX(backup."catalog_revision"),
  COALESCE(MAX(backup."restore_generation"), 0),
  NOW()
FROM "agent_sandbox_backups" AS backup
WHERE backup."catalog_organization_id" IS NOT NULL
  AND backup."catalog_agent_id" IS NOT NULL
GROUP BY backup."catalog_organization_id", backup."catalog_agent_id"
ON CONFLICT ("organization_id", "agent_id") DO NOTHING;

DO $$ BEGIN
  ALTER TABLE "agent_sandbox_backups"
    ADD CONSTRAINT "agent_sandbox_backups_catalog_organization_id_fkey"
    FOREIGN KEY ("catalog_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
