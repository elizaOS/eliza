-- Owner-bound lease shapes and uniqueness. Mutation policy is installed after vault bindings exist.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
    'agent_backup_restore_leases_shape_check'
    AND conrelid = 'agent_backup_restore_leases'::regclass) THEN
    ALTER TABLE "agent_backup_restore_leases" ADD CONSTRAINT
      "agent_backup_restore_leases_shape_check" CHECK ((
        "owner_id" = btrim("owner_id") AND octet_length("owner_id") BETWEEN 1 AND 255
        AND "lifecycle_revision" BETWEEN 0 AND 18446744073709551615
        AND "catalog_epoch" >= 0 AND "expected_manifest_sha256" ~ '^[0-9a-f]{64}$'
        AND "copy_role" IN ('primary', 'secondary')
        AND "expires_at" > "created_at"
        AND ("released_at" IS NULL OR "released_at" >= "created_at")
      ) IS TRUE);
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_leases_generation_uidx"
  ON "agent_backup_restore_leases" ("organization_id", "backup_id", "generation");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_leases_attempt_uidx"
  ON "agent_backup_restore_leases" ("organization_id", "restore_attempt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_backup_restore_leases_one_unreleased_uidx"
  ON "agent_backup_restore_leases" ("organization_id", "backup_id")
  WHERE "released_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_backup_restore_leases_active_idx"
  ON "agent_backup_restore_leases" ("organization_id", "backup_id", "expires_at")
  WHERE "released_at" IS NULL;
