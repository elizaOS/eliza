-- Re-key boot authority on (node record, incarnation) so a reused boot can re-attest.
--
-- 0246 kept a global UNIQUE on "node_incarnation" alongside the composite
-- ("docker_node_record_id", "node_incarnation"). The trigger resolved on the
-- global arbiter, so a boot UUID stayed bound to the first docker_nodes row that
-- ever carried it: delete that row, re-register the same host without rebooting,
-- and the journal refused the incarnation forever. The composite key already
-- carries the invariant that matters -- for a given record and incarnation the
-- typed identity is immutable -- while the global key conflated "boot UUID" with
-- "node record". No foreign key references the global constraint.

ALTER TABLE "agent_node_incarnation_histories"
  DROP CONSTRAINT IF EXISTS "agent_node_incarnation_histories_incarnation_unique";
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
  ON CONFLICT ("docker_node_record_id", "node_incarnation") DO NOTHING;
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
