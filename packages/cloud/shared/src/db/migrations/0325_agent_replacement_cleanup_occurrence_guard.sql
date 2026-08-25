-- Expand phase: enforce exact occurrence authority whenever a new caller supplies it.
CREATE OR REPLACE FUNCTION "enforce_agent_replacement_cleanup_occurrence"()
RETURNS trigger LANGUAGE plpgsql AS $occurrence$
DECLARE
  core_changed boolean;
  primary_cutover boolean;
BEGIN
  IF NEW."replacement_cleanup_sandbox_id" IS NULL THEN RETURN NEW; END IF;
  -- A wholly legacy fence stays writable until the contract migration drains it.
  IF NEW."replacement_cleanup_node_record_id" IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    core_changed := true;
  ELSIF OLD."replacement_cleanup_sandbox_id" IS NULL THEN
    core_changed := true;
  ELSE
    core_changed := ROW(
      OLD."replacement_cleanup_sandbox_id", OLD."replacement_cleanup_node_id",
      OLD."replacement_cleanup_container_name", OLD."replacement_cleanup_attempt_id"
    ) IS DISTINCT FROM ROW(
      NEW."replacement_cleanup_sandbox_id", NEW."replacement_cleanup_node_id",
      NEW."replacement_cleanup_container_name", NEW."replacement_cleanup_attempt_id"
    );
    IF NOT core_changed AND ROW(
      OLD."replacement_cleanup_node_record_id",
      OLD."replacement_cleanup_node_incarnation",
      OLD."replacement_cleanup_node_history_id",
      OLD."replacement_cleanup_node_hostname", OLD."replacement_cleanup_node_ssh_port",
      OLD."replacement_cleanup_node_ssh_user",
      OLD."replacement_cleanup_node_host_key_fingerprint",
      OLD."replacement_cleanup_secret_cleanup_version"
    ) IS DISTINCT FROM ROW(
      NEW."replacement_cleanup_node_record_id",
      NEW."replacement_cleanup_node_incarnation",
      NEW."replacement_cleanup_node_history_id",
      NEW."replacement_cleanup_node_hostname", NEW."replacement_cleanup_node_ssh_port",
      NEW."replacement_cleanup_node_ssh_user",
      NEW."replacement_cleanup_node_host_key_fingerprint",
      NEW."replacement_cleanup_secret_cleanup_version"
    ) THEN
      RAISE EXCEPTION 'replacement cleanup occurrence authority is immutable'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF core_changed THEN
    primary_cutover := TG_OP = 'UPDATE'
      AND ROW(NEW."replacement_cleanup_sandbox_id",
        NEW."replacement_cleanup_node_id",
        NEW."replacement_cleanup_container_name") IS NOT DISTINCT FROM
        ROW(OLD."sandbox_id", OLD."node_id", OLD."container_name")
      AND (
        (NEW."replacement_cleanup_attempt_id" IS NULL
          AND OLD."replacement_cleanup_sandbox_id" IS NULL)
        OR (NEW."replacement_cleanup_attempt_id" IS NOT NULL
          AND NEW."replacement_cleanup_attempt_id"
            IS NOT DISTINCT FROM OLD."replacement_cleanup_attempt_id"
          AND OLD."replacement_cleanup_secret_cleanup_version" = 1
          AND EXISTS (
            SELECT 1 FROM "agent_sandbox_replacement_attempts" AS attempt
            WHERE attempt."id" = NEW."replacement_cleanup_attempt_id"
              AND attempt."organization_id" = NEW."organization_id"
              AND attempt."agent_id" = NEW."id"
              AND attempt."state" = 'provider_succeeded'
              AND attempt."capacity_state" = 'reserved'))
      );
    IF (NEW."replacement_cleanup_secret_cleanup_version" IS NULL) <> primary_cutover THEN
      RAISE EXCEPTION 'replacement cleanup protocol does not match cutover state'
        USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM "docker_nodes" AS node
    WHERE node."id" = NEW."replacement_cleanup_node_record_id"
      AND node."node_id" = NEW."replacement_cleanup_node_id"
      AND node."node_incarnation" = NEW."replacement_cleanup_node_incarnation"
      AND node."current_node_history_id" = NEW."replacement_cleanup_node_history_id"
      AND node."hostname" = NEW."replacement_cleanup_node_hostname"
      AND node."ssh_port" = NEW."replacement_cleanup_node_ssh_port"
      AND node."ssh_user" = NEW."replacement_cleanup_node_ssh_user"
      AND node."host_key_fingerprint"
        = NEW."replacement_cleanup_node_host_key_fingerprint"
      AND node."allocated_count" > 0
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'replacement cleanup requires the exact current node occurrence'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$occurrence$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandboxes_replacement_cleanup_occurrence_guard"
  ON "agent_sandboxes";
--> statement-breakpoint
CREATE TRIGGER "agent_sandboxes_replacement_cleanup_occurrence_guard"
  BEFORE INSERT OR UPDATE ON "agent_sandboxes"
  FOR EACH ROW EXECUTE FUNCTION "enforce_agent_replacement_cleanup_occurrence"();
