-- Expand-safe guard: the restore source may hand capacity to exactly one matching receiver.
CREATE OR REPLACE FUNCTION "enforce_agent_restore_capacity_handoff"()
RETURNS trigger LANGUAGE plpgsql AS $handoff$
DECLARE
  receiver_count integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."capacity_state" IN ('reserved', 'handed_off') THEN
      RAISE EXCEPTION 'owned restore capacity cannot be deleted before settlement'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."capacity_state" = 'handed_off' THEN
    SELECT count(*) INTO receiver_count
    FROM "agent_sandbox_replacement_attempts" AS receiver
    WHERE receiver."organization_id" = NEW."organization_id"
      AND receiver."restore_attempt_id" = NEW."restore_attempt_id"
      AND ((receiver."state" IN ('in_flight_unresolved', 'provider_succeeded')
          AND receiver."capacity_state" = 'reserved')
        OR (receiver."state" = 'lifecycle_committed'
          AND receiver."capacity_state" = 'handed_off'))
      AND receiver."locator_node_id" = NEW."expected_node_id"
      AND receiver."locator_node_record_id" = NEW."expected_node_record_id"
      AND receiver."locator_node_incarnation" = NEW."expected_node_incarnation"
      AND receiver."locator_node_history_id" = NEW."expected_node_history_id"
      AND receiver."capacity_reserved_at" = NEW."capacity_settled_at";
    IF receiver_count <> 1 THEN
      RAISE EXCEPTION 'restore capacity handoff requires one exact durable receiver'
        USING ERRCODE = '55000';
    END IF;
    IF NEW."phase" = 'finalized' AND NOT EXISTS (
      SELECT 1 FROM "agent_sandbox_replacement_attempts" AS receiver
      WHERE receiver."organization_id" = NEW."organization_id"
        AND receiver."restore_attempt_id" = NEW."restore_attempt_id"
        AND receiver."state" = 'lifecycle_committed'
        AND receiver."capacity_state" = 'handed_off'
        AND receiver."locator_node_id" = NEW."expected_node_id"
        AND receiver."locator_node_record_id" = NEW."expected_node_record_id"
        AND receiver."locator_node_incarnation" = NEW."expected_node_incarnation"
        AND receiver."locator_node_history_id" = NEW."expected_node_history_id"
        AND receiver."capacity_reserved_at" = NEW."capacity_settled_at"
    ) THEN
      RAISE EXCEPTION 'finalized restore requires its exact committed capacity receiver'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$handoff$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_capacity_handoff_guard"
  ON "agent_backup_restore_operations";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agent_backup_restore_capacity_handoff_guard"
  AFTER INSERT OR UPDATE OR DELETE ON "agent_backup_restore_operations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "enforce_agent_restore_capacity_handoff"();
