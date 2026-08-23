-- Replace the fail-closed cutover guard with causal occurrence journaling.

LOCK TABLE "docker_nodes" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "agent_node_incarnation_histories" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "journal_agent_node_incarnation"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  occurrence_id uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."current_node_history_id" IS NOT NULL THEN
      RAISE EXCEPTION 'current node history id is trigger-owned'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW."current_node_history_id" IS DISTINCT FROM OLD."current_node_history_id" THEN
    RAISE EXCEPTION 'current node history id is trigger-owned'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."node_incarnation" IS NULL THEN
    NEW."current_node_history_id" := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."node_incarnation" IS NOT NULL
    AND NEW."node_incarnation" IS NOT DISTINCT FROM OLD."node_incarnation" THEN
    SELECT history."id" INTO occurrence_id
    FROM "agent_node_incarnation_histories" history
    WHERE history."id" = OLD."current_node_history_id"
      AND history."docker_node_record_id" = NEW."id"
      AND history."node_incarnation" = NEW."node_incarnation"
      AND history."node_id" = NEW."node_id"
      AND history."fleet_kind" = NEW."fleet_kind"
      AND history."infrastructure_provider" = NEW."infrastructure_provider"
      AND history."provider_server_id" IS NOT DISTINCT FROM NEW."provider_server_id"
      AND history."host_key_fingerprint" = NEW."host_key_fingerprint";
    IF occurrence_id IS NULL THEN
      RAISE EXCEPTION 'node occurrence conflicts with immutable history'
        USING ERRCODE = '55000';
    END IF;
    NEW."current_node_history_id" := occurrence_id;
    RETURN NEW;
  END IF;

  INSERT INTO "agent_node_incarnation_histories" (
    "docker_node_record_id", "node_id", "node_incarnation", "fleet_kind",
    "infrastructure_provider", "provider_server_id", "host_key_fingerprint"
  ) VALUES (
    NEW."id", NEW."node_id", NEW."node_incarnation", NEW."fleet_kind",
    NEW."infrastructure_provider", NEW."provider_server_id",
    NEW."host_key_fingerprint"
  ) RETURNING "id" INTO occurrence_id;
  NEW."current_node_history_id" := occurrence_id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER "docker_nodes_occurrence_cutover_guard" ON "docker_nodes";
--> statement-breakpoint
CREATE TRIGGER "docker_nodes_incarnation_history"
  BEFORE INSERT OR UPDATE OF
    "node_id", "node_incarnation", "fleet_kind", "infrastructure_provider",
    "provider_server_id", "host_key_fingerprint", "current_node_history_id"
  ON "docker_nodes"
  FOR EACH ROW EXECUTE FUNCTION "journal_agent_node_incarnation"();
--> statement-breakpoint
DROP FUNCTION "block_agent_node_occurrence_cutover"();
