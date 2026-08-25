-- Backfill one durable token for every live Docker-node occurrence.
-- A temporary trigger blocks identity writes until 0301 installs journaling.

LOCK TABLE "docker_nodes" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE "agent_node_incarnation_histories" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE "docker_nodes"
  ADD COLUMN IF NOT EXISTS "current_node_history_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_node_incarnation_histories"
  DROP CONSTRAINT IF EXISTS
    "agent_node_incarnation_histories_record_incarnation_unique";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_node_incarnation_histories_record_incarnation_idx"
  ON "agent_node_incarnation_histories"
    ("docker_node_record_id", "node_incarnation");
--> statement-breakpoint
DROP TRIGGER "docker_nodes_incarnation_history" ON "docker_nodes";
--> statement-breakpoint
-- Mint a fresh baseline instead of reusing a pre-cutover history row. This
-- preserves old receipt meaning while establishing an unambiguous live token.
WITH "fresh_baselines" AS MATERIALIZED (
  SELECT
    gen_random_uuid() AS "history_id", node."id" AS "docker_node_record_id",
    node."node_id", node."node_incarnation", node."fleet_kind",
    node."infrastructure_provider", node."provider_server_id",
    node."host_key_fingerprint"
  FROM "docker_nodes" node
  WHERE node."node_incarnation" IS NOT NULL
    AND node."current_node_history_id" IS NULL
), "inserted_baselines" AS (
  INSERT INTO "agent_node_incarnation_histories" (
    "id", "docker_node_record_id", "node_id", "node_incarnation", "fleet_kind",
    "infrastructure_provider", "provider_server_id", "host_key_fingerprint",
    "attested_at"
  )
  SELECT
    baseline."history_id", baseline."docker_node_record_id", baseline."node_id",
    baseline."node_incarnation", baseline."fleet_kind",
    baseline."infrastructure_provider", baseline."provider_server_id",
    baseline."host_key_fingerprint", clock_timestamp()
  FROM "fresh_baselines" baseline
  RETURNING "id", "docker_node_record_id"
)
UPDATE "docker_nodes" node
SET "current_node_history_id" = baseline."id"
FROM "inserted_baselines" baseline
WHERE node."id" = baseline."docker_node_record_id";
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "docker_nodes" node
    LEFT JOIN "agent_node_incarnation_histories" history
      ON history."id" = node."current_node_history_id"
     AND history."docker_node_record_id" = node."id"
     AND history."node_incarnation" = node."node_incarnation"
    WHERE (node."node_incarnation" IS NULL)
        IS DISTINCT FROM (node."current_node_history_id" IS NULL)
      OR (node."node_incarnation" IS NOT NULL AND (
        history."id" IS NULL OR history."node_id" <> node."node_id"
        OR history."fleet_kind" <> node."fleet_kind"
        OR history."infrastructure_provider" <> node."infrastructure_provider"
        OR history."provider_server_id" IS DISTINCT FROM node."provider_server_id"
        OR history."host_key_fingerprint" <> node."host_key_fingerprint"
      ))
  ) THEN
    RAISE EXCEPTION 'current Docker-node occurrence conflicts with immutable history'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "docker_nodes"
  ADD CONSTRAINT "docker_nodes_current_node_history_fkey"
  FOREIGN KEY ("current_node_history_id", "id", "node_incarnation")
  REFERENCES "agent_node_incarnation_histories"
    ("id", "docker_node_record_id", "node_incarnation")
  ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "docker_nodes"
  ADD CONSTRAINT "docker_nodes_node_occurrence_shape_check"
  CHECK (("node_incarnation" IS NULL) = ("current_node_history_id" IS NULL));
--> statement-breakpoint
CREATE FUNCTION "block_agent_node_occurrence_cutover"()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'Docker-node occurrence trigger cutover is incomplete'
    USING ERRCODE = '55000';
END; $$;
--> statement-breakpoint
CREATE TRIGGER "docker_nodes_occurrence_cutover_guard"
  BEFORE INSERT OR UPDATE OF
    "node_id", "node_incarnation", "fleet_kind", "infrastructure_provider",
    "provider_server_id", "host_key_fingerprint", "current_node_history_id"
  ON "docker_nodes"
  FOR EACH ROW EXECUTE FUNCTION "block_agent_node_occurrence_cutover"();
