-- Contract phase preflight: legacy fences must be drained by the caller rollout
-- before exact occurrence authority becomes mandatory.
DO $preflight$
BEGIN
  LOCK TABLE "agent_sandboxes" IN ACCESS EXCLUSIVE MODE NOWAIT;
  IF EXISTS (
    SELECT 1 FROM "agent_sandboxes"
    WHERE "replacement_cleanup_sandbox_id" IS NOT NULL
      AND ("replacement_cleanup_node_record_id" IS NULL
        OR "replacement_cleanup_node_incarnation" IS NULL
        OR "replacement_cleanup_node_history_id" IS NULL
        OR "replacement_cleanup_node_hostname" IS NULL
        OR "replacement_cleanup_node_ssh_port" IS NULL
        OR "replacement_cleanup_node_ssh_user" IS NULL
        OR "replacement_cleanup_node_host_key_fingerprint" IS NULL)
  ) THEN
    RAISE EXCEPTION 'cleanup occurrence contract requires legacy fences to be converged'
      USING ERRCODE = '55000';
  END IF;
END;
$preflight$;
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  DROP CONSTRAINT IF EXISTS "agent_sandboxes_replacement_cleanup_occurrence_compat_check";
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  DROP CONSTRAINT IF EXISTS "agent_sandboxes_replacement_cleanup_occurrence_check";
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  ADD CONSTRAINT "agent_sandboxes_replacement_cleanup_occurrence_check" CHECK ((
    ("replacement_cleanup_sandbox_id" IS NULL
      AND "replacement_cleanup_node_record_id" IS NULL
      AND "replacement_cleanup_node_incarnation" IS NULL
      AND "replacement_cleanup_node_history_id" IS NULL
      AND "replacement_cleanup_node_hostname" IS NULL
      AND "replacement_cleanup_node_ssh_port" IS NULL
      AND "replacement_cleanup_node_ssh_user" IS NULL
      AND "replacement_cleanup_node_host_key_fingerprint" IS NULL
      AND "replacement_cleanup_secret_cleanup_version" IS NULL)
    OR
    ("replacement_cleanup_sandbox_id" IS NOT NULL
      AND "replacement_cleanup_node_record_id" IS NOT NULL
      AND "replacement_cleanup_node_incarnation" IS NOT NULL
      AND "replacement_cleanup_node_history_id" IS NOT NULL
      AND btrim("replacement_cleanup_node_hostname") <> ''
      AND "replacement_cleanup_node_ssh_port" BETWEEN 1 AND 65535
      AND btrim("replacement_cleanup_node_ssh_user") <> ''
      AND btrim("replacement_cleanup_node_host_key_fingerprint") <> ''
      AND (("replacement_cleanup_attempt_id" IS NOT NULL
          AND "replacement_cleanup_secret_cleanup_version" = 1)
        OR ("replacement_cleanup_secret_cleanup_version" IS NULL
          AND "replacement_cleanup_attempt_id" IS NOT NULL
          AND "replacement_cleanup_container_id" ~ '^[0-9a-f]{64}$'
          AND "replacement_cleanup_vpn_node_name" IS NULL
          AND "replacement_cleanup_preserved_vpn_node_id" IS NULL
          AND "replacement_cleanup_vpn_registration_started_at" IS NULL
          AND "replacement_cleanup_allocation_counted" IS TRUE)))
  ) IS TRUE);
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  DROP CONSTRAINT IF EXISTS "agent_sandboxes_replacement_cleanup_node_occurrence_fkey";
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  ADD CONSTRAINT "agent_sandboxes_replacement_cleanup_node_occurrence_fkey"
  FOREIGN KEY (
    "replacement_cleanup_node_history_id", "replacement_cleanup_node_record_id",
    "replacement_cleanup_node_incarnation", "replacement_cleanup_node_id"
  ) REFERENCES "agent_node_incarnation_histories" (
    "id", "docker_node_record_id", "node_incarnation", "node_id"
  ) ON DELETE RESTRICT;
