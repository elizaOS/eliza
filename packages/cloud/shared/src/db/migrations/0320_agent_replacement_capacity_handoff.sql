-- A committed receiver owns the exact new placement and retains the counted previous occurrence.
CREATE OR REPLACE FUNCTION "enforce_agent_replacement_capacity_handoff"() RETURNS trigger LANGUAGE plpgsql AS $handoff$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."capacity_state" = 'reserved' THEN
      RAISE EXCEPTION 'reserved replacement capacity cannot be deleted before settlement' USING ERRCODE = '55000';
    END IF;
    IF OLD."restore_attempt_id" IS NOT NULL AND OLD."capacity_state" IS NOT NULL
      AND EXISTS (SELECT 1 FROM "agent_backup_restore_operations" AS source
        WHERE source."organization_id" = OLD."organization_id"
          AND source."restore_attempt_id" = OLD."restore_attempt_id"
          AND source."capacity_state" = 'handed_off'
          AND ROW(source."expected_node_id", source."expected_node_record_id",
            source."expected_node_incarnation", source."expected_node_history_id",
            source."capacity_settled_at") IS NOT DISTINCT FROM ROW(
            OLD."locator_node_id", OLD."locator_node_record_id",
            OLD."locator_node_incarnation", OLD."locator_node_history_id",
            OLD."capacity_reserved_at")) THEN
      RAISE EXCEPTION 'handed-off restore capacity cannot lose its durable receiver' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."state" = 'lifecycle_committed' AND NEW."capacity_state" = 'handed_off'
    AND NOT EXISTS (
      SELECT 1 FROM "agent_sandboxes" AS sandbox
      JOIN "docker_nodes" AS node ON ROW(node."id", node."node_id", node."node_incarnation",
        node."current_node_history_id", node."hostname", node."ssh_port", node."ssh_user",
        node."host_key_fingerprint") IS NOT DISTINCT FROM ROW(NEW."locator_node_record_id",
        NEW."locator_node_id", NEW."locator_node_incarnation", NEW."locator_node_history_id",
        NEW."locator_node_hostname", NEW."locator_node_ssh_port", NEW."locator_node_ssh_user",
        NEW."locator_node_host_key_fingerprint") AND node."allocated_count" > 0
      WHERE sandbox."organization_id" = NEW."organization_id" AND sandbox."id" = NEW."agent_id"
        AND ROW(sandbox."sandbox_id", sandbox."node_id", sandbox."container_name")
          IS NOT DISTINCT FROM ROW(NEW."locator_sandbox_id", NEW."locator_node_id",
            NEW."locator_container_name")
        AND sandbox."activation_generation" = NEW."activation_generation"
        AND sandbox."lifecycle_revision" = NEW."lifecycle_revision" + 1
        AND sandbox."lifecycle_job_id" IS NOT DISTINCT FROM NEW."lifecycle_job_id"
        AND sandbox."lifecycle_execution_generation"
          IS NOT DISTINCT FROM NEW."lifecycle_execution_generation"
        AND sandbox."deletion_attempt_id" IS NULL
        AND (sandbox."deletion_allocation_counted" IS TRUE OR
          (sandbox."deletion_allocation_counted" IS NULL
            AND sandbox."status" NOT IN ('stopped', 'error', 'sleeping', 'deletion_failed')))
        AND ((NEW."previous_placement_absent" IS TRUE
          AND NEW."operation_kind" = 'provision' AND NEW."restore_attempt_id" IS NULL
          AND num_nonnulls(sandbox."replacement_cleanup_sandbox_id",
            sandbox."replacement_cleanup_node_id", sandbox."replacement_cleanup_node_record_id",
            sandbox."replacement_cleanup_container_name",
            sandbox."replacement_cleanup_attempt_id", sandbox."replacement_cleanup_container_id",
            sandbox."replacement_cleanup_allocation_counted") = 0)
        OR (NEW."previous_placement_absent" IS FALSE
          AND NEW."previous_node_id" IS DISTINCT FROM NEW."locator_node_id"
          AND NEW."previous_node_record_id" IS DISTINCT FROM NEW."locator_node_record_id"
          AND sandbox."replacement_cleanup_attempt_id" = NEW."id"
          AND sandbox."replacement_cleanup_created_at" IS NOT NULL
          AND sandbox."replacement_cleanup_secret_cleanup_version" IS NULL
          AND ROW(sandbox."replacement_cleanup_sandbox_id", sandbox."replacement_cleanup_node_id",
            sandbox."replacement_cleanup_container_name", sandbox."replacement_cleanup_container_id",
            sandbox."replacement_cleanup_allocation_counted", sandbox."replacement_cleanup_node_record_id",
            sandbox."replacement_cleanup_node_incarnation", sandbox."replacement_cleanup_node_history_id",
            sandbox."replacement_cleanup_node_hostname", sandbox."replacement_cleanup_node_ssh_port",
            sandbox."replacement_cleanup_node_ssh_user", sandbox."replacement_cleanup_node_host_key_fingerprint")
            IS NOT DISTINCT FROM ROW(NEW."previous_sandbox_id", NEW."previous_node_id",
            NEW."previous_container_name", NEW."previous_container_id", NEW."previous_allocation_counted",
            NEW."previous_node_record_id", NEW."previous_node_incarnation", NEW."previous_node_history_id",
            NEW."previous_node_hostname", NEW."previous_node_ssh_port", NEW."previous_node_ssh_user",
            NEW."previous_node_host_key_fingerprint")
          AND EXISTS (SELECT 1 FROM "docker_nodes" AS previous_node
            WHERE ROW(previous_node."id", previous_node."node_id", previous_node."node_incarnation",
              previous_node."current_node_history_id", previous_node."hostname", previous_node."ssh_port",
              previous_node."ssh_user", previous_node."host_key_fingerprint") IS NOT DISTINCT FROM ROW(
              NEW."previous_node_record_id", NEW."previous_node_id", NEW."previous_node_incarnation",
              NEW."previous_node_history_id", NEW."previous_node_hostname", NEW."previous_node_ssh_port",
              NEW."previous_node_ssh_user", NEW."previous_node_host_key_fingerprint")
              AND previous_node."allocated_count" > 0)))
    ) THEN
    RAISE EXCEPTION 'lifecycle-committed capacity requires exact canonical and previous placements' USING ERRCODE = '55000';
  END IF;
  IF NEW."restore_attempt_id" IS NOT NULL AND NEW."capacity_state" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "agent_backup_restore_operations" AS source
      WHERE source."organization_id" = NEW."organization_id"
        AND source."restore_attempt_id" = NEW."restore_attempt_id"
        AND source."capacity_state" = 'handed_off'
        AND ROW(source."expected_node_id", source."expected_node_record_id",
          source."expected_node_incarnation", source."expected_node_history_id",
          source."capacity_settled_at") IS NOT DISTINCT FROM ROW(NEW."locator_node_id",
          NEW."locator_node_record_id", NEW."locator_node_incarnation",
          NEW."locator_node_history_id", NEW."capacity_reserved_at")) THEN
    RAISE EXCEPTION 'restore-linked receiver requires one exact handed-off source' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$handoff$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandbox_replacement_capacity_handoff_guard" ON "agent_sandbox_replacement_attempts";
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "agent_sandbox_replacement_capacity_handoff_guard" AFTER INSERT OR UPDATE OR DELETE ON "agent_sandbox_replacement_attempts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "enforce_agent_replacement_capacity_handoff"();
