-- Expand-safe guard: restore capacity is acquired after intent insert and settles exactly once.
CREATE OR REPLACE FUNCTION "guard_agent_restore_capacity_insert"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF num_nonnulls(
    NEW."expected_node_id", NEW."capacity_state", NEW."capacity_reserved_at",
    NEW."capacity_settled_at", NEW."capacity_settlement_receipt_digest"
  ) <> 0 THEN
    RAISE EXCEPTION 'restore capacity authority must be acquired after insert'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_restore_capacity_update"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF ROW(
      OLD."expected_node_id", OLD."capacity_state", OLD."capacity_reserved_at",
      OLD."capacity_settled_at", OLD."capacity_settlement_receipt_digest"
    ) IS NOT DISTINCT FROM ROW(
      NEW."expected_node_id", NEW."capacity_state", NEW."capacity_reserved_at",
      NEW."capacity_settled_at", NEW."capacity_settlement_receipt_digest"
    ) THEN
    RAISE EXCEPTION 'restore capacity replay must not rewrite durable authority'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."expected_node_id" IS NOT NULL
    AND NEW."expected_node_id" IS DISTINCT FROM OLD."expected_node_id" THEN
    RAISE EXCEPTION 'restore expected node id is write-once' USING ERRCODE = '55000';
  END IF;

  IF OLD."capacity_state" IS NULL THEN
    IF NEW."capacity_state" IS DISTINCT FROM 'reserved'
      OR NEW."expected_node_id" IS NULL THEN
      RAISE EXCEPTION 'restore capacity must transition from null to reserved'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD."capacity_state" = 'reserved' THEN
    IF NEW."capacity_state" NOT IN ('handed_off', 'released')
      OR NEW."capacity_reserved_at" IS DISTINCT FROM OLD."capacity_reserved_at" THEN
      RAISE EXCEPTION 'restore capacity must settle once from its reservation'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'terminal restore capacity authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_capacity_insert_guard"
  ON "agent_backup_restore_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_capacity_insert_guard"
  BEFORE INSERT ON "agent_backup_restore_operations"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_restore_capacity_insert"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_capacity_update_guard"
  ON "agent_backup_restore_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_capacity_update_guard"
  BEFORE UPDATE OF "expected_node_id", "capacity_state", "capacity_reserved_at",
    "capacity_settled_at", "capacity_settlement_receipt_digest"
  ON "agent_backup_restore_operations"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_restore_capacity_update"();
