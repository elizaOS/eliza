-- Expand: a committed handoff keeps cleanup immutable until its exact receipt settles.
CREATE OR REPLACE FUNCTION "enforce_agent_replacement_cleanup_release"() RETURNS trigger LANGUAGE plpgsql AS $cleanup$
DECLARE
  current_sandbox "agent_sandboxes"%ROWTYPE;
  existing_handoff boolean; final_matching_handoff boolean; previous_cleanup_released boolean;
BEGIN
  SELECT * INTO current_sandbox FROM "agent_sandboxes"
  WHERE "id" = NEW."id" AND "organization_id" = NEW."organization_id";
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT
    attempt."state" = 'lifecycle_committed' AND attempt."capacity_state" = 'handed_off',
    attempt."previous_cleanup_state" = 'released'
      AND attempt."previous_cleanup_proven_at" IS NOT NULL
      AND attempt."previous_cleanup_receipt_digest" ~ '^[0-9a-f]{64}$'
      AND ROW(attempt."previous_sandbox_id", attempt."previous_node_id",
        attempt."previous_container_name", attempt."previous_container_id",
        attempt."previous_allocation_counted", attempt."previous_node_record_id",
        attempt."previous_node_incarnation", attempt."previous_node_history_id",
        attempt."previous_node_hostname", attempt."previous_node_ssh_port",
        attempt."previous_node_ssh_user", attempt."previous_node_host_key_fingerprint")
        IS NOT DISTINCT FROM ROW(
        OLD."replacement_cleanup_sandbox_id", OLD."replacement_cleanup_node_id",
        OLD."replacement_cleanup_container_name", OLD."replacement_cleanup_container_id",
        OLD."replacement_cleanup_allocation_counted", OLD."replacement_cleanup_node_record_id",
        OLD."replacement_cleanup_node_incarnation", OLD."replacement_cleanup_node_history_id",
        OLD."replacement_cleanup_node_hostname", OLD."replacement_cleanup_node_ssh_port",
        OLD."replacement_cleanup_node_ssh_user", OLD."replacement_cleanup_node_host_key_fingerprint")
  INTO existing_handoff, previous_cleanup_released
  FROM "agent_sandbox_replacement_attempts" AS attempt
  WHERE attempt."id" = OLD."replacement_cleanup_attempt_id"
    AND attempt."organization_id" = OLD."organization_id" AND attempt."agent_id" = OLD."id";
  IF NOT COALESCE(existing_handoff, FALSE) THEN RETURN NEW; END IF;
  SELECT EXISTS (
    SELECT 1 FROM "agent_sandbox_replacement_attempts" AS attempt
    WHERE attempt."id" = current_sandbox."replacement_cleanup_attempt_id"
      AND attempt."organization_id" = current_sandbox."organization_id"
      AND attempt."agent_id" = current_sandbox."id"
      AND attempt."state" = 'lifecycle_committed'
      AND attempt."capacity_state" = 'handed_off'
      AND attempt."locator_sandbox_id" = current_sandbox."sandbox_id"
      AND attempt."locator_node_id" = current_sandbox."node_id"
      AND attempt."locator_container_name" = current_sandbox."container_name"
  ) INTO final_matching_handoff;
  IF final_matching_handoff AND NOT (
    (OLD."replacement_cleanup_secret_cleanup_version" IS NOT DISTINCT FROM 1
      AND current_sandbox."replacement_cleanup_secret_cleanup_version" IS NULL
      AND current_sandbox."replacement_cleanup_attempt_id"
        IS NOT DISTINCT FROM OLD."replacement_cleanup_attempt_id")
    OR (ROW(
      OLD."replacement_cleanup_sandbox_id", OLD."replacement_cleanup_node_id", OLD."replacement_cleanup_node_record_id",
      OLD."replacement_cleanup_node_incarnation", OLD."replacement_cleanup_node_history_id", OLD."replacement_cleanup_node_hostname",
      OLD."replacement_cleanup_node_ssh_port", OLD."replacement_cleanup_node_ssh_user", OLD."replacement_cleanup_node_host_key_fingerprint",
      OLD."replacement_cleanup_secret_cleanup_version", OLD."replacement_cleanup_container_name", OLD."replacement_cleanup_attempt_id",
      OLD."replacement_cleanup_vpn_node_name", OLD."replacement_cleanup_preserved_vpn_node_id",
      OLD."replacement_cleanup_vpn_registration_started_at", OLD."replacement_cleanup_allocation_counted", OLD."replacement_cleanup_created_at"
    ) IS NOT DISTINCT FROM ROW(
      current_sandbox."replacement_cleanup_sandbox_id", current_sandbox."replacement_cleanup_node_id", current_sandbox."replacement_cleanup_node_record_id",
      current_sandbox."replacement_cleanup_node_incarnation", current_sandbox."replacement_cleanup_node_history_id", current_sandbox."replacement_cleanup_node_hostname",
      current_sandbox."replacement_cleanup_node_ssh_port", current_sandbox."replacement_cleanup_node_ssh_user", current_sandbox."replacement_cleanup_node_host_key_fingerprint",
      current_sandbox."replacement_cleanup_secret_cleanup_version", current_sandbox."replacement_cleanup_container_name", current_sandbox."replacement_cleanup_attempt_id",
      current_sandbox."replacement_cleanup_vpn_node_name", current_sandbox."replacement_cleanup_preserved_vpn_node_id",
      current_sandbox."replacement_cleanup_vpn_registration_started_at", current_sandbox."replacement_cleanup_allocation_counted", current_sandbox."replacement_cleanup_created_at"
    )
    AND (OLD."replacement_cleanup_container_id" IS NULL OR current_sandbox."replacement_cleanup_container_id"
      IS NOT DISTINCT FROM OLD."replacement_cleanup_container_id")
    AND (OLD."replacement_cleanup_vpn_node_id" IS NULL OR current_sandbox."replacement_cleanup_vpn_node_id"
      IS NOT DISTINCT FROM OLD."replacement_cleanup_vpn_node_id"))
  ) THEN
    RAISE EXCEPTION 'pending replacement cleanup permits only monotone remote enrichment' USING ERRCODE = '55000';
  END IF;
  IF NOT final_matching_handoff AND (
    ROW(current_sandbox."sandbox_id", current_sandbox."node_id", current_sandbox."container_name")
      IS DISTINCT FROM ROW(OLD."sandbox_id", OLD."node_id", OLD."container_name")
    OR num_nonnulls(
      current_sandbox."replacement_cleanup_sandbox_id", current_sandbox."replacement_cleanup_node_id",
      current_sandbox."replacement_cleanup_node_record_id", current_sandbox."replacement_cleanup_node_incarnation",
      current_sandbox."replacement_cleanup_node_history_id", current_sandbox."replacement_cleanup_node_hostname",
      current_sandbox."replacement_cleanup_node_ssh_port", current_sandbox."replacement_cleanup_node_ssh_user",
      current_sandbox."replacement_cleanup_node_host_key_fingerprint", current_sandbox."replacement_cleanup_secret_cleanup_version",
      current_sandbox."replacement_cleanup_container_name", current_sandbox."replacement_cleanup_attempt_id",
      current_sandbox."replacement_cleanup_container_id", current_sandbox."replacement_cleanup_vpn_node_id",
      current_sandbox."replacement_cleanup_vpn_node_name", current_sandbox."replacement_cleanup_preserved_vpn_node_id",
      current_sandbox."replacement_cleanup_vpn_registration_started_at", current_sandbox."replacement_cleanup_allocation_counted",
      current_sandbox."replacement_cleanup_created_at"
    ) <> 0
  ) THEN
    RAISE EXCEPTION 'pending replacement cleanup may only be cleared exactly'
      USING ERRCODE = '55000';
  END IF;
  IF NOT final_matching_handoff AND NOT COALESCE(previous_cleanup_released, FALSE) THEN
    RAISE EXCEPTION 'replacement cleanup release requires a durable previous-cleanup receipt' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$cleanup$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandboxes_replacement_cleanup_release_guard" ON "agent_sandboxes";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agent_sandboxes_replacement_cleanup_release_guard" AFTER UPDATE ON "agent_sandboxes" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_agent_replacement_cleanup_release"();
