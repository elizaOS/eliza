-- Persist one exact Linux image generation in two monotone steps: target
-- reservation binds its platform, then the registry verifier binds the
-- canonical parent reference and exact platform-manifest digest atomically.

LOCK TABLE "agent_backup_restore_operations" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations"
  ADD COLUMN IF NOT EXISTS "expected_image_platform" text,
  ADD COLUMN IF NOT EXISTS "expected_image_reference" text,
  ADD COLUMN IF NOT EXISTS "expected_image_platform_digest" text;
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations"
  DROP CONSTRAINT IF EXISTS "agent_backup_restore_operations_expected_shape_check",
  ADD CONSTRAINT "agent_backup_restore_operations_expected_shape_check" CHECK ((
    "attempts" >= 0 AND "catalog_epoch" >= 0
    AND "expected_lifecycle_revision" BETWEEN 0 AND 18446744073709551615
    AND "expected_manifest_sha256" ~ '^[0-9a-f]{64}$'
    AND "copy_role" IN ('primary','secondary')
    AND btrim("lease_owner_id") = "lease_owner_id"
    AND octet_length("lease_owner_id") BETWEEN 1 AND 255
    AND ("expected_container_id" IS NULL
      OR "expected_container_id" ~ '^[0-9a-f]{64}$')
    AND ("expected_container_id" IS NULL OR "expected_node_history_id" IS NOT NULL)
    AND ("expected_image_digest" IS NULL
      OR "expected_image_digest" ~ '^sha256:[0-9a-f]{64}$')
    AND (("expected_node_history_id" IS NULL
        AND "expected_node_record_id" IS NULL
        AND "expected_node_incarnation" IS NULL
        AND "expected_image_digest" IS NULL
        AND "expected_image_platform" IS NULL)
      OR ("expected_node_history_id" IS NOT NULL
        AND "expected_node_record_id" IS NOT NULL
        AND "expected_node_incarnation" IS NOT NULL
        AND "expected_image_digest" IS NOT NULL
        AND "expected_image_platform" IN ('linux/amd64','linux/arm64')))
  ) IS TRUE);
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations"
  DROP CONSTRAINT IF EXISTS "agent_backup_restore_operations_exact_image_shape_check",
  ADD CONSTRAINT "agent_backup_restore_operations_exact_image_shape_check" CHECK ((
    (("expected_image_reference" IS NULL
        AND "expected_image_platform_digest" IS NULL)
      OR ("expected_image_reference" IS NOT NULL
        AND octet_length("expected_image_reference") BETWEEN 1 AND 335
        AND "expected_image_reference" ~ '^ghcr\.io/[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$'
        AND right("expected_image_reference", 72) = '@' || "expected_image_digest"
        AND "expected_image_platform_digest" ~ '^sha256:[0-9a-f]{64}$'))
  ) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_exact_image_authority"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."expected_image_platform" IS NOT NULL
      AND NEW."expected_image_platform" IS DISTINCT FROM OLD."expected_image_platform")
    OR (OLD."expected_image_reference" IS NOT NULL
      AND NEW."expected_image_reference" IS DISTINCT FROM OLD."expected_image_reference")
    OR (OLD."expected_image_platform_digest" IS NOT NULL
      AND NEW."expected_image_platform_digest" IS DISTINCT FROM OLD."expected_image_platform_digest") THEN
    RAISE EXCEPTION 'restore operation exact image authority is write-once: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_exact_image_authority_guard"
  ON "agent_backup_restore_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_exact_image_authority_guard"
  BEFORE UPDATE OF "expected_image_platform", "expected_image_reference",
    "expected_image_platform_digest"
  ON "agent_backup_restore_operations"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_backup_restore_exact_image_authority"();
