-- DB-owned lease lifecycle; NOWAIT renewal reproof avoids lease-to-backup deadlocks.
CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_lease"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  db_now timestamptz;
  requested_ttl interval;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'restore lease cannot be deleted' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'INSERT' THEN
    requested_ttl := NEW."expires_at" - NEW."created_at";
    IF NEW."released_at" IS NOT NULL OR requested_ttl <= INTERVAL '0 seconds'
      OR requested_ttl > INTERVAL '1 hour' THEN
      RAISE EXCEPTION 'restore lease insert has an invalid bounded lifecycle' USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM "agent_sandbox_backups" AS backup
      JOIN "agent_vault_key_backup_bindings" AS binding
        ON binding."organization_id" = backup."catalog_organization_id"
        AND binding."backup_id" = backup."id"
        AND binding."vault_key_generation_id" = backup."vault_key_generation_id"
        AND binding."vault_key_authority_receipt_digest" = backup."vault_key_authority_receipt_digest"
      WHERE backup."id" = NEW."backup_id"
        AND backup."catalog_organization_id" = NEW."organization_id"
        AND backup."catalog_agent_id" = NEW."agent_id"
        AND backup."backup_operation_id" = NEW."operation_id"
        AND backup."lifecycle_generation" = NEW."activation_generation"
        AND backup."lifecycle_revision" = NEW."lifecycle_revision"
        AND backup."manifest_digest" = NEW."expected_manifest_sha256"
        AND backup."catalog_state" IN ('protected', 'retained', 'restore_verified')
        AND backup."manifest_version" = 3 FOR NO KEY UPDATE OF backup;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'restore lease source authority is not restorable'
        USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM "agent_backup_catalog_authorities" AS authority
      WHERE authority."organization_id" = NEW."organization_id"
        AND authority."agent_id" = NEW."agent_id"
        AND authority."catalog_revision" = NEW."catalog_epoch" FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'restore lease catalogue epoch is stale' USING ERRCODE = '55000';
    END IF;
    db_now := clock_timestamp();
    NEW."created_at" := db_now;
    NEW."expires_at" := db_now + requested_ttl;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'expires_at' - 'released_at') IS DISTINCT FROM
    (to_jsonb(OLD) - 'expires_at' - 'released_at') OR OLD."released_at" IS NOT NULL THEN
    RAISE EXCEPTION 'restore lease immutable authority cannot change' USING ERRCODE = '55000';
  END IF;
  IF NEW."released_at" IS NOT NULL THEN
    IF NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
      RAISE EXCEPTION 'restore lease release cannot alter expiry' USING ERRCODE = '55000';
    END IF;
    NEW."released_at" := clock_timestamp();
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "agent_sandbox_backups" AS backup
    JOIN "agent_vault_key_backup_bindings" AS binding
      ON binding."organization_id" = backup."catalog_organization_id"
      AND binding."backup_id" = backup."id"
      AND binding."vault_key_generation_id" = backup."vault_key_generation_id"
      AND binding."vault_key_authority_receipt_digest" = backup."vault_key_authority_receipt_digest"
    WHERE backup."id" = OLD."backup_id"
      AND backup."catalog_organization_id" = OLD."organization_id"
      AND backup."catalog_agent_id" = OLD."agent_id"
      AND backup."backup_operation_id" = OLD."operation_id"
      AND backup."lifecycle_generation" = OLD."activation_generation"
      AND backup."lifecycle_revision" = OLD."lifecycle_revision"
      AND backup."manifest_digest" = OLD."expected_manifest_sha256"
      AND backup."catalog_state" IN ('protected', 'retained', 'restore_verified')
      AND backup."manifest_version" = 3 FOR NO KEY UPDATE OF backup NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'restore lease renewal source authority is stale' USING ERRCODE = '55000';
  END IF;
  PERFORM 1 FROM "agent_backup_catalog_authorities" AS authority
    WHERE authority."organization_id" = OLD."organization_id"
      AND authority."agent_id" = OLD."agent_id"
      AND authority."catalog_revision" = OLD."catalog_epoch" FOR NO KEY UPDATE NOWAIT;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'restore lease renewal catalogue epoch is stale' USING ERRCODE = '55000';
  END IF;
  db_now := clock_timestamp();
  IF OLD."expires_at" <= db_now OR NEW."expires_at" <= OLD."expires_at"
    OR NEW."expires_at" > db_now + INTERVAL '1 hour' THEN
    RAISE EXCEPTION 'restore lease renewal must be live, monotone, and bounded'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_lease_guard" ON "agent_backup_restore_leases";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_lease_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "agent_backup_restore_leases"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_restore_lease"();
