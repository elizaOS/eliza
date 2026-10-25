-- Admit only empty unresolved attempts and allow deletion solely through the
-- owning organization cascade after terminal settlement.

CREATE OR REPLACE FUNCTION "guard_agent_sandbox_replacement_attempt_admission"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'replacement attempts cannot be truncated';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 2
      AND OLD."state" IN ('lifecycle_committed', 'cleanup_proven')
      AND NOT EXISTS (
        SELECT 1 FROM "organizations" WHERE "id" = OLD."organization_id"
      ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'replacement attempts cannot be deleted before terminal owner erasure';
  END IF;
  IF NEW."state" <> 'in_flight_unresolved'
    OR num_nonnulls(
      NEW."locator_sandbox_id", NEW."locator_node_id", NEW."locator_container_name",
      NEW."locator_node_record_id", NEW."locator_node_incarnation",
      NEW."locator_node_history_id", NEW."locator_node_hostname", NEW."locator_node_ssh_port",
      NEW."locator_node_ssh_user", NEW."locator_node_host_key_fingerprint",
      NEW."locator_secret_cleanup_version", NEW."locator_allocation_counted",
      NEW."locator_vpn_node_name", NEW."locator_vpn_registration_started_at",
      NEW."locator_previous_vpn_node_id", NEW."locator_recorded_at",
      NEW."locator_container_id", NEW."locator_container_recorded_at",
      NEW."locator_vpn_node_id", NEW."locator_vpn_recorded_at",
      NEW."provider_succeeded_at", NEW."provider_receipt_digest",
      NEW."lifecycle_committed_at", NEW."lifecycle_receipt_digest",
      NEW."cleanup_proven_at", NEW."cleanup_receipt_digest"
    ) <> 0 THEN
    RAISE EXCEPTION 'replacement attempt must start before any provider evidence';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_replacement_attempts_guard_insert"
  BEFORE INSERT ON "agent_sandbox_replacement_attempts"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_sandbox_replacement_attempt_admission"();
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_replacement_attempts_guard_delete"
  BEFORE DELETE ON "agent_sandbox_replacement_attempts"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_sandbox_replacement_attempt_admission"();
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_replacement_attempts_guard_truncate"
  BEFORE TRUNCATE ON "agent_sandbox_replacement_attempts"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_agent_sandbox_replacement_attempt_admission"();
