-- Caller-support guard: exact candidate cleanup mirrors one reserved attempt;
-- it may disappear only in the same transaction that durably releases it.
CREATE OR REPLACE FUNCTION "enforce_agent_replacement_candidate_cleanup"()
RETURNS trigger LANGUAGE plpgsql AS $candidate$
DECLARE
  current_sandbox "agent_sandboxes"%ROWTYPE;
  exact_candidate boolean; final_handoff boolean; released_candidate boolean;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id" THEN
    RAISE EXCEPTION 'agent sandbox tenant identity is immutable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO current_sandbox FROM "agent_sandboxes"
  WHERE "id" = OLD."id" AND "organization_id" = OLD."organization_id";
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF OLD."replacement_cleanup_attempt_id" IS NOT NULL
    AND OLD."replacement_cleanup_secret_cleanup_version" = 1
    AND current_sandbox."replacement_cleanup_attempt_id"
      IS DISTINCT FROM OLD."replacement_cleanup_attempt_id" THEN
    SELECT EXISTS (SELECT 1 FROM "agent_sandbox_replacement_attempts" AS attempt
      WHERE attempt."id" = OLD."replacement_cleanup_attempt_id"
        AND attempt."organization_id" = OLD."organization_id" AND attempt."agent_id" = OLD."id"
        AND attempt."state" = 'cleanup_proven' AND attempt."capacity_state" = 'released'
        AND ROW(attempt."locator_sandbox_id", attempt."locator_node_id", attempt."locator_node_record_id",
          attempt."locator_node_incarnation", attempt."locator_node_history_id", attempt."locator_node_hostname",
          attempt."locator_node_ssh_port", attempt."locator_node_ssh_user", attempt."locator_node_host_key_fingerprint",
          attempt."locator_secret_cleanup_version", attempt."locator_container_name", attempt."locator_container_id",
          attempt."locator_vpn_node_id", attempt."locator_vpn_node_name", attempt."locator_previous_vpn_node_id",
          attempt."locator_vpn_registration_started_at", attempt."locator_allocation_counted") IS NOT DISTINCT FROM ROW(
          OLD."replacement_cleanup_sandbox_id", OLD."replacement_cleanup_node_id", OLD."replacement_cleanup_node_record_id",
          OLD."replacement_cleanup_node_incarnation", OLD."replacement_cleanup_node_history_id", OLD."replacement_cleanup_node_hostname",
          OLD."replacement_cleanup_node_ssh_port", OLD."replacement_cleanup_node_ssh_user", OLD."replacement_cleanup_node_host_key_fingerprint",
          OLD."replacement_cleanup_secret_cleanup_version", OLD."replacement_cleanup_container_name", OLD."replacement_cleanup_container_id",
          OLD."replacement_cleanup_vpn_node_id", OLD."replacement_cleanup_vpn_node_name", OLD."replacement_cleanup_preserved_vpn_node_id",
          OLD."replacement_cleanup_vpn_registration_started_at", OLD."replacement_cleanup_allocation_counted")
    ) INTO released_candidate;
    IF NOT released_candidate THEN
      RAISE EXCEPTION 'candidate cleanup requires exact durable release' USING ERRCODE = '55000';
    END IF;
  END IF;
  -- A pre-rollout worker may still write a wholly legacy logical fence.
  IF current_sandbox."replacement_cleanup_node_record_id" IS NULL THEN RETURN NEW; END IF;
  IF current_sandbox."replacement_cleanup_attempt_id" IS NULL THEN RETURN NEW; END IF;
  SELECT EXISTS (SELECT 1 FROM "agent_sandbox_replacement_attempts" AS attempt
    WHERE attempt."id" = current_sandbox."replacement_cleanup_attempt_id"
      AND attempt."organization_id" = current_sandbox."organization_id" AND attempt."agent_id" = current_sandbox."id"
      AND attempt."state" IN ('in_flight_unresolved', 'provider_succeeded') AND attempt."capacity_state" = 'reserved'
      AND ROW(attempt."locator_sandbox_id", attempt."locator_node_id", attempt."locator_node_record_id",
        attempt."locator_node_incarnation", attempt."locator_node_history_id", attempt."locator_node_hostname",
        attempt."locator_node_ssh_port", attempt."locator_node_ssh_user", attempt."locator_node_host_key_fingerprint",
        attempt."locator_secret_cleanup_version", attempt."locator_container_name", attempt."locator_container_id",
        attempt."locator_vpn_node_id", attempt."locator_vpn_node_name", attempt."locator_previous_vpn_node_id",
        attempt."locator_vpn_registration_started_at", attempt."locator_allocation_counted") IS NOT DISTINCT FROM ROW(
        current_sandbox."replacement_cleanup_sandbox_id", current_sandbox."replacement_cleanup_node_id", current_sandbox."replacement_cleanup_node_record_id",
        current_sandbox."replacement_cleanup_node_incarnation", current_sandbox."replacement_cleanup_node_history_id", current_sandbox."replacement_cleanup_node_hostname",
        current_sandbox."replacement_cleanup_node_ssh_port", current_sandbox."replacement_cleanup_node_ssh_user", current_sandbox."replacement_cleanup_node_host_key_fingerprint",
        current_sandbox."replacement_cleanup_secret_cleanup_version", current_sandbox."replacement_cleanup_container_name", current_sandbox."replacement_cleanup_container_id",
        current_sandbox."replacement_cleanup_vpn_node_id", current_sandbox."replacement_cleanup_vpn_node_name", current_sandbox."replacement_cleanup_preserved_vpn_node_id",
        current_sandbox."replacement_cleanup_vpn_registration_started_at", current_sandbox."replacement_cleanup_allocation_counted")
  ) INTO exact_candidate;
  SELECT EXISTS (SELECT 1 FROM "agent_sandbox_replacement_attempts" AS attempt
    WHERE attempt."id" = current_sandbox."replacement_cleanup_attempt_id"
      AND attempt."organization_id" = current_sandbox."organization_id" AND attempt."agent_id" = current_sandbox."id"
      AND attempt."state" = 'lifecycle_committed' AND attempt."capacity_state" = 'handed_off'
      AND attempt."locator_sandbox_id" = current_sandbox."sandbox_id"
      AND attempt."locator_node_id" = current_sandbox."node_id"
      AND attempt."locator_container_name" = current_sandbox."container_name"
  ) INTO final_handoff;
  IF (current_sandbox."replacement_cleanup_secret_cleanup_version" = 1 AND NOT exact_candidate)
    OR (current_sandbox."replacement_cleanup_secret_cleanup_version" IS NULL AND NOT final_handoff) THEN
    RAISE EXCEPTION 'replacement cleanup does not match its durable attempt authority'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$candidate$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandboxes_replacement_candidate_cleanup_guard" ON "agent_sandboxes";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agent_sandboxes_replacement_candidate_cleanup_guard"
  AFTER UPDATE ON "agent_sandboxes" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "enforce_agent_replacement_candidate_cleanup"();
