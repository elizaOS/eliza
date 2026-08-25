-- Expand-safe guard: replacement capacity follows the same null -> reserved -> terminal graph.
CREATE OR REPLACE FUNCTION "guard_agent_replacement_capacity_insert"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF num_nonnulls(
    NEW."capacity_state", NEW."capacity_reserved_at", NEW."capacity_settled_at",
    NEW."capacity_settlement_receipt_digest"
  ) <> 0 THEN
    RAISE EXCEPTION 'replacement capacity authority must be acquired after insert'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_replacement_capacity_update"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF ROW(
      OLD."capacity_state", OLD."capacity_reserved_at", OLD."capacity_settled_at",
      OLD."capacity_settlement_receipt_digest"
    ) IS NOT DISTINCT FROM ROW(
      NEW."capacity_state", NEW."capacity_reserved_at", NEW."capacity_settled_at",
      NEW."capacity_settlement_receipt_digest"
    ) THEN
    RAISE EXCEPTION 'replacement capacity replay must not rewrite durable authority'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."capacity_state" IS NULL THEN
    IF NEW."capacity_state" IS DISTINCT FROM 'reserved'
      OR NEW."locator_recorded_at" IS NULL THEN
      RAISE EXCEPTION 'replacement capacity must transition from null to reserved'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD."capacity_state" = 'reserved' THEN
    IF NEW."capacity_state" NOT IN ('handed_off', 'released')
      OR NEW."capacity_reserved_at" IS DISTINCT FROM OLD."capacity_reserved_at" THEN
      RAISE EXCEPTION 'replacement capacity must settle once from its reservation'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'terminal replacement capacity authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandbox_replacement_capacity_insert_guard"
  ON "agent_sandbox_replacement_attempts";
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_replacement_capacity_insert_guard"
  BEFORE INSERT ON "agent_sandbox_replacement_attempts"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_replacement_capacity_insert"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandbox_replacement_capacity_update_guard"
  ON "agent_sandbox_replacement_attempts";
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_replacement_capacity_update_guard"
  BEFORE UPDATE OF "capacity_state", "capacity_reserved_at", "capacity_settled_at",
    "capacity_settlement_receipt_digest"
  ON "agent_sandbox_replacement_attempts"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_replacement_capacity_update"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_replacement_previous_placement_mode"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF ROW(
      NEW."previous_placement_absent", NEW."previous_sandbox_id", NEW."previous_node_id",
      NEW."previous_container_name", NEW."previous_container_id",
      NEW."previous_allocation_counted", NEW."previous_node_record_id",
      NEW."previous_node_incarnation", NEW."previous_node_history_id",
      NEW."previous_node_hostname", NEW."previous_node_ssh_port",
      NEW."previous_node_ssh_user", NEW."previous_node_host_key_fingerprint"
    ) IS DISTINCT FROM ROW(
      OLD."previous_placement_absent", OLD."previous_sandbox_id", OLD."previous_node_id",
      OLD."previous_container_name", OLD."previous_container_id",
      OLD."previous_allocation_counted", OLD."previous_node_record_id",
      OLD."previous_node_incarnation", OLD."previous_node_history_id",
      OLD."previous_node_hostname", OLD."previous_node_ssh_port",
      OLD."previous_node_ssh_user", OLD."previous_node_host_key_fingerprint") THEN
    RAISE EXCEPTION 'replacement previous-placement authority is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandbox_replacement_previous_placement_mode_guard"
  ON "agent_sandbox_replacement_attempts";
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_replacement_previous_placement_mode_guard"
  BEFORE UPDATE OF "previous_placement_absent", "previous_sandbox_id", "previous_node_id",
    "previous_container_name", "previous_container_id", "previous_allocation_counted",
    "previous_node_record_id", "previous_node_incarnation", "previous_node_history_id",
    "previous_node_hostname", "previous_node_ssh_port", "previous_node_ssh_user",
    "previous_node_host_key_fingerprint" ON "agent_sandbox_replacement_attempts"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_replacement_previous_placement_mode"();
