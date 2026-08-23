-- Bind each restore target to the exact durable Docker-node occurrence.

LOCK TABLE "agent_backup_restore_operations" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "agent_node_incarnation_histories" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  -- Existing target bindings cannot be assigned a causal token safely from
  -- the mutable node row. Fail closed instead of inventing backfill authority.
  IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
      WHERE attrelid = 'agent_backup_restore_operations'::regclass
        AND attname = 'expected_node_history_id' AND NOT attisdropped
    ) AND EXISTS (
      SELECT 1 FROM "agent_backup_restore_operations"
      WHERE "expected_node_record_id" IS NOT NULL
        OR "expected_node_incarnation" IS NOT NULL
        OR "expected_container_id" IS NOT NULL
        OR "expected_image_digest" IS NOT NULL
    ) THEN
    RAISE EXCEPTION
      'node occurrence authority migration requires target-free restore operations'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations"
  ADD COLUMN IF NOT EXISTS "expected_node_history_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations"
  DROP CONSTRAINT IF EXISTS "agent_backup_restore_operations_expected_shape_check";
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations"
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
        AND "expected_image_digest" IS NULL)
      OR ("expected_node_history_id" IS NOT NULL
        AND "expected_node_record_id" IS NOT NULL
        AND "expected_node_incarnation" IS NOT NULL
        AND "expected_image_digest" IS NOT NULL))
  ) IS TRUE);
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations"
  ADD CONSTRAINT "agent_backup_restore_operations_node_occurrence_fkey"
  FOREIGN KEY (
    "expected_node_history_id", "expected_node_record_id",
    "expected_node_incarnation"
  ) REFERENCES "agent_node_incarnation_histories" (
    "id", "docker_node_record_id", "node_incarnation"
  ) ON DELETE RESTRICT;
--> statement-breakpoint
-- Keep the existing phase/identity guard untouched and add one narrow trigger
-- for the new write-once field. A null target may be bound once; it can never
-- be cleared or replaced afterward, including through a raw SQL writer.
CREATE OR REPLACE FUNCTION "guard_agent_restore_target_occurrence"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."expected_node_history_id" IS NOT NULL
    AND NEW."expected_node_history_id" IS DISTINCT FROM OLD."expected_node_history_id" THEN
    RAISE EXCEPTION 'restore operation target occurrence is write-once: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_target_occurrence_guard"
  BEFORE UPDATE OF "expected_node_history_id"
  ON "agent_backup_restore_operations"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_restore_target_occurrence"();
