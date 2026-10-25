-- Append-only boot authority survives mutable Docker-node reuse and deletion.

CREATE TABLE IF NOT EXISTS "agent_node_incarnation_histories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "docker_node_record_id" uuid NOT NULL, "node_id" text NOT NULL,
  "node_incarnation" uuid NOT NULL, "fleet_kind" text NOT NULL,
  "infrastructure_provider" text NOT NULL, "provider_server_id" text,
  "host_key_fingerprint" text NOT NULL,
  "attested_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "agent_node_incarnation_histories_incarnation_unique" UNIQUE
    ("node_incarnation"),
  CONSTRAINT "agent_node_incarnation_histories_record_incarnation_unique" UNIQUE
    ("docker_node_record_id", "node_incarnation"),
  CONSTRAINT "agent_node_incarnation_histories_receipt_authority_unique" UNIQUE
    ("id", "docker_node_record_id", "node_incarnation"),
  CONSTRAINT "agent_node_incarnation_histories_shape_check" CHECK ((
    "node_id" = btrim("node_id") AND octet_length("node_id") BETWEEN 1 AND 255
    AND "fleet_kind" IN ('robot', 'cloud') AND "infrastructure_provider" = 'hetzner'
    AND btrim("host_key_fingerprint") <> ''
    AND (("fleet_kind" = 'robot' AND "provider_server_id" IS NULL)
      OR ("fleet_kind" = 'cloud' AND "provider_server_id" ~ '^[1-9][0-9]{0,19}$'))
  ) IS TRUE)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "journal_agent_node_incarnation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."node_incarnation" IS NULL THEN RETURN NEW; END IF;
  INSERT INTO "agent_node_incarnation_histories" (
    "docker_node_record_id", "node_id", "node_incarnation", "fleet_kind",
    "infrastructure_provider", "provider_server_id", "host_key_fingerprint")
  VALUES (NEW."id", NEW."node_id", NEW."node_incarnation", NEW."fleet_kind",
    NEW."infrastructure_provider", NEW."provider_server_id", NEW."host_key_fingerprint")
  ON CONFLICT ("node_incarnation") DO NOTHING;
  IF NOT EXISTS (SELECT 1 FROM "agent_node_incarnation_histories" history
    WHERE history."node_incarnation" = NEW."node_incarnation"
      AND history."docker_node_record_id" = NEW."id"
      AND history."node_id" = NEW."node_id"
      AND history."fleet_kind" = NEW."fleet_kind"
      AND history."infrastructure_provider" = NEW."infrastructure_provider"
      AND history."provider_server_id" IS NOT DISTINCT FROM NEW."provider_server_id"
      AND history."host_key_fingerprint" = NEW."host_key_fingerprint") THEN
    RAISE EXCEPTION 'node incarnation conflicts with immutable history' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
INSERT INTO "agent_node_incarnation_histories" (
  "docker_node_record_id", "node_id", "node_incarnation", "fleet_kind",
  "infrastructure_provider", "provider_server_id", "host_key_fingerprint", "attested_at")
SELECT "id", "node_id", "node_incarnation", "fleet_kind", "infrastructure_provider",
  "provider_server_id", "host_key_fingerprint", "updated_at" FROM "docker_nodes"
WHERE "node_incarnation" IS NOT NULL ON CONFLICT ("node_incarnation") DO NOTHING;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "docker_nodes" node LEFT JOIN
    "agent_node_incarnation_histories" history
      ON history."node_incarnation" = node."node_incarnation"
    WHERE node."node_incarnation" IS NOT NULL AND (history."id" IS NULL
      OR history."docker_node_record_id" <> node."id" OR history."node_id" <> node."node_id"
      OR history."fleet_kind" <> node."fleet_kind"
      OR history."infrastructure_provider" <> node."infrastructure_provider"
      OR history."provider_server_id" IS DISTINCT FROM node."provider_server_id"
      OR history."host_key_fingerprint" <> node."host_key_fingerprint")) THEN
    RAISE EXCEPTION 'current node incarnation conflicts with immutable history' USING ERRCODE='55000';
  END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "docker_nodes_incarnation_history" ON "docker_nodes";
--> statement-breakpoint
CREATE TRIGGER "docker_nodes_incarnation_history" BEFORE INSERT OR UPDATE OF
  "node_id", "node_incarnation", "fleet_kind", "infrastructure_provider",
  "provider_server_id", "host_key_fingerprint" ON "docker_nodes"
  FOR EACH ROW EXECUTE FUNCTION "journal_agent_node_incarnation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_node_incarnation_histories_immutable"
  ON "agent_node_incarnation_histories";
--> statement-breakpoint
CREATE TRIGGER "agent_node_incarnation_histories_immutable"
  BEFORE UPDATE OR DELETE ON "agent_node_incarnation_histories"
  FOR EACH ROW EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_node_incarnation_histories_truncate_guard"
  ON "agent_node_incarnation_histories";
--> statement-breakpoint
CREATE TRIGGER "agent_node_incarnation_histories_truncate_guard"
  BEFORE TRUNCATE ON "agent_node_incarnation_histories"
  FOR EACH STATEMENT EXECUTE FUNCTION "reject_agent_restore_immutable_mutation"();
