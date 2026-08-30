-- Make the exact replacement placement and its Docker/VPN enrichments
-- write-once, including after provider settlement begins.

CREATE OR REPLACE FUNCTION "guard_agent_sandbox_replacement_attempt_locator"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF OLD."locator_recorded_at" IS NULL THEN
    IF NEW."locator_recorded_at" IS NOT NULL
      AND (NEW."locator_container_id" IS NOT NULL OR NEW."locator_vpn_node_id" IS NOT NULL) THEN
      RAISE EXCEPTION 'replacement locator enrichments cannot skip intent';
    END IF;
  ELSIF ROW(
    OLD."locator_sandbox_id", OLD."locator_node_id", OLD."locator_container_name",
    OLD."locator_node_record_id", OLD."locator_node_incarnation",
    OLD."locator_node_history_id", OLD."locator_node_hostname", OLD."locator_node_ssh_port",
    OLD."locator_node_ssh_user", OLD."locator_node_host_key_fingerprint",
    OLD."locator_secret_cleanup_version", OLD."locator_allocation_counted",
    OLD."locator_vpn_node_name", OLD."locator_vpn_registration_started_at",
    OLD."locator_previous_vpn_node_id", OLD."locator_recorded_at"
  ) IS DISTINCT FROM ROW(
    NEW."locator_sandbox_id", NEW."locator_node_id", NEW."locator_container_name",
    NEW."locator_node_record_id", NEW."locator_node_incarnation",
    NEW."locator_node_history_id", NEW."locator_node_hostname", NEW."locator_node_ssh_port",
    NEW."locator_node_ssh_user", NEW."locator_node_host_key_fingerprint",
    NEW."locator_secret_cleanup_version", NEW."locator_allocation_counted",
    NEW."locator_vpn_node_name", NEW."locator_vpn_registration_started_at",
    NEW."locator_previous_vpn_node_id", NEW."locator_recorded_at"
  ) THEN
    RAISE EXCEPTION 'replacement locator identity is immutable';
  END IF;
  IF OLD."locator_container_id" IS NULL THEN
    IF NEW."locator_container_id" IS NOT NULL AND OLD."locator_recorded_at" IS NULL THEN
      RAISE EXCEPTION 'replacement Docker enrichment requires durable intent';
    END IF;
  ELSIF ROW(OLD."locator_container_id", OLD."locator_container_recorded_at")
    IS DISTINCT FROM ROW(NEW."locator_container_id", NEW."locator_container_recorded_at") THEN
    RAISE EXCEPTION 'replacement Docker enrichment is immutable';
  END IF;
  IF OLD."locator_vpn_node_id" IS NULL THEN
    IF NEW."locator_vpn_node_id" IS NOT NULL AND OLD."locator_container_id" IS NULL THEN
      RAISE EXCEPTION 'replacement VPN enrichment requires durable Docker identity';
    END IF;
  ELSIF ROW(OLD."locator_vpn_node_id", OLD."locator_vpn_recorded_at")
    IS DISTINCT FROM ROW(NEW."locator_vpn_node_id", NEW."locator_vpn_recorded_at") THEN
    RAISE EXCEPTION 'replacement VPN enrichment is immutable';
  END IF;
  IF OLD."state" <> 'in_flight_unresolved'
    AND ROW(
      OLD."locator_sandbox_id", OLD."locator_node_id", OLD."locator_container_name",
      OLD."locator_node_record_id", OLD."locator_node_incarnation",
      OLD."locator_node_history_id", OLD."locator_node_hostname", OLD."locator_node_ssh_port",
      OLD."locator_node_ssh_user", OLD."locator_node_host_key_fingerprint",
      OLD."locator_secret_cleanup_version", OLD."locator_allocation_counted",
      OLD."locator_vpn_node_name", OLD."locator_vpn_registration_started_at",
      OLD."locator_previous_vpn_node_id", OLD."locator_recorded_at",
      OLD."locator_container_id", OLD."locator_container_recorded_at",
      OLD."locator_vpn_node_id", OLD."locator_vpn_recorded_at"
    ) IS DISTINCT FROM ROW(
      NEW."locator_sandbox_id", NEW."locator_node_id", NEW."locator_container_name",
      NEW."locator_node_record_id", NEW."locator_node_incarnation",
      NEW."locator_node_history_id", NEW."locator_node_hostname", NEW."locator_node_ssh_port",
      NEW."locator_node_ssh_user", NEW."locator_node_host_key_fingerprint",
      NEW."locator_secret_cleanup_version", NEW."locator_allocation_counted",
      NEW."locator_vpn_node_name", NEW."locator_vpn_registration_started_at",
      NEW."locator_previous_vpn_node_id", NEW."locator_recorded_at",
      NEW."locator_container_id", NEW."locator_container_recorded_at",
      NEW."locator_vpn_node_id", NEW."locator_vpn_recorded_at"
    ) THEN
    RAISE EXCEPTION 'settled replacement locator is immutable';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_replacement_attempts_guard_locator"
  BEFORE UPDATE ON "agent_sandbox_replacement_attempts"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_sandbox_replacement_attempt_locator"();
