-- Every new attempt is classified; same-generation moves require its immutable previous publication.
ALTER TABLE "agent_sandbox_replacement_attempts" DROP CONSTRAINT IF EXISTS "agent_sandbox_replacement_attempts_previous_placement_mode_check";
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts" ADD CONSTRAINT "agent_sandbox_replacement_attempts_previous_placement_mode_check" CHECK ((
    "previous_placement_absent" = FALSE OR ("previous_placement_absent" = TRUE
      AND "operation_kind" = 'provision' AND "restore_attempt_id" IS NULL)) IS TRUE);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_agent_replacement_previous_placement"() RETURNS trigger LANGUAGE plpgsql AS $handoff$
DECLARE
  current_sandbox "agent_sandboxes"%ROWTYPE;
  cleanup_changed boolean; fresh_final_handoff boolean; candidate_capacity_fence boolean;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id" THEN
    RAISE EXCEPTION 'agent sandbox tenant identity is immutable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO current_sandbox FROM "agent_sandboxes" WHERE "id" = OLD."id" AND "organization_id" = OLD."organization_id";
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT COALESCE(bool_or(
      attempt."state" = 'lifecycle_committed' AND attempt."capacity_state" = 'handed_off'
      AND current_sandbox."lifecycle_revision" = attempt."lifecycle_revision" + 1
      AND ROW(current_sandbox."sandbox_id", current_sandbox."node_id",
        current_sandbox."container_name") IS NOT DISTINCT FROM ROW(
        attempt."locator_sandbox_id", attempt."locator_node_id", attempt."locator_container_name")
      AND ROW(current_sandbox."replacement_cleanup_sandbox_id",
        current_sandbox."replacement_cleanup_node_id",
        current_sandbox."replacement_cleanup_container_name",
        current_sandbox."replacement_cleanup_container_id",
        current_sandbox."replacement_cleanup_allocation_counted") IS NOT DISTINCT FROM ROW(
        attempt."previous_sandbox_id", attempt."previous_node_id",
        attempt."previous_container_name", attempt."previous_container_id",
        attempt."previous_allocation_counted")), FALSE),
    COALESCE(bool_or(attempt."state" IN ('in_flight_unresolved', 'provider_succeeded')
      AND attempt."capacity_state" = 'reserved'
      AND current_sandbox."lifecycle_revision" = OLD."lifecycle_revision"
      AND ROW(current_sandbox."sandbox_id", current_sandbox."node_id",
        current_sandbox."container_name") IS NOT DISTINCT FROM ROW(
        OLD."sandbox_id", OLD."node_id", OLD."container_name")), FALSE)
    INTO fresh_final_handoff, candidate_capacity_fence
  FROM "agent_sandbox_replacement_attempts" AS attempt
  JOIN "agent_activation_publications" AS publication
    ON publication."organization_id" = attempt."organization_id"
    AND publication."agent_id" = attempt."agent_id"
    AND publication."activation_generation" = attempt."activation_generation"
    AND ROW(publication."container_id", publication."node_id",
      publication."docker_node_record_id", publication."node_incarnation",
      publication."node_history_id") IS NOT DISTINCT FROM ROW(attempt."previous_container_id",
      attempt."previous_node_id", attempt."previous_node_record_id",
      attempt."previous_node_incarnation", attempt."previous_node_history_id")
  JOIN "agent_node_incarnation_histories" AS history
    ON ROW(history."id", history."docker_node_record_id", history."node_incarnation",
      history."node_id", history."host_key_fingerprint") IS NOT DISTINCT FROM ROW(
      attempt."previous_node_history_id", attempt."previous_node_record_id",
      attempt."previous_node_incarnation", attempt."previous_node_id",
      attempt."previous_node_host_key_fingerprint")
  WHERE attempt."id" = current_sandbox."replacement_cleanup_attempt_id"
    AND attempt."organization_id" = current_sandbox."organization_id"
    AND attempt."agent_id" = current_sandbox."id"
    AND attempt."previous_placement_absent" IS FALSE
    AND attempt."lifecycle_revision" = OLD."lifecycle_revision"
    AND attempt."activation_generation" = OLD."activation_generation"
    AND attempt."activation_generation" = current_sandbox."activation_generation"
    AND attempt."lifecycle_job_id" IS NOT DISTINCT FROM OLD."lifecycle_job_id"
    AND attempt."lifecycle_execution_generation"
      IS NOT DISTINCT FROM OLD."lifecycle_execution_generation"
    AND attempt."lifecycle_job_id" IS NOT DISTINCT FROM current_sandbox."lifecycle_job_id"
    AND attempt."lifecycle_execution_generation"
      IS NOT DISTINCT FROM current_sandbox."lifecycle_execution_generation"
    AND ROW(attempt."previous_sandbox_id", attempt."previous_node_id",
      attempt."previous_container_name") IS NOT DISTINCT FROM ROW(
      OLD."sandbox_id", OLD."node_id", OLD."container_name");
  cleanup_changed := current_sandbox."replacement_cleanup_attempt_id" IS NOT NULL
    AND ROW(OLD."replacement_cleanup_sandbox_id", OLD."replacement_cleanup_node_id",
      OLD."replacement_cleanup_container_name", OLD."replacement_cleanup_attempt_id")
      IS DISTINCT FROM ROW(current_sandbox."replacement_cleanup_sandbox_id",
      current_sandbox."replacement_cleanup_node_id",
      current_sandbox."replacement_cleanup_container_name",
      current_sandbox."replacement_cleanup_attempt_id");
  IF ROW(OLD."sandbox_id", OLD."node_id", OLD."container_name") IS DISTINCT FROM
      ROW(current_sandbox."sandbox_id", current_sandbox."node_id", current_sandbox."container_name")
    AND current_sandbox."activation_generation" IS NOT DISTINCT FROM OLD."activation_generation"
    AND NOT ((num_nonnulls(OLD."sandbox_id", OLD."node_id", OLD."container_name") = 0
        AND num_nonnulls(current_sandbox."sandbox_id", current_sandbox."node_id",
          current_sandbox."container_name") = 3)
      OR (num_nonnulls(OLD."sandbox_id", OLD."node_id", OLD."container_name") > 0
        AND num_nonnulls(current_sandbox."sandbox_id", current_sandbox."node_id",
          current_sandbox."container_name") = 0) OR fresh_final_handoff) THEN
    RAISE EXCEPTION 'replacement adoption requires fresh immutable previous-placement authority' USING ERRCODE = '55000';
  END IF;
  IF cleanup_changed AND NOT (candidate_capacity_fence OR fresh_final_handoff) THEN
    RAISE EXCEPTION 'replacement cleanup attempt is not fresh candidate or handoff authority' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$handoff$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandboxes_replacement_previous_placement_guard" ON "agent_sandboxes";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agent_sandboxes_replacement_previous_placement_guard" AFTER UPDATE ON "agent_sandboxes" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "enforce_agent_replacement_previous_placement"();
