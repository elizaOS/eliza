-- Expand compatibility: a pre-rollout writer may persist a wholly legacy
-- cleanup fence; exact callers must provide the complete occurrence bundle.
ALTER TABLE "agent_sandboxes"
  DROP CONSTRAINT IF EXISTS "agent_sandboxes_replacement_cleanup_occurrence_compat_check";
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  ADD CONSTRAINT "agent_sandboxes_replacement_cleanup_occurrence_compat_check" CHECK ((
    ("replacement_cleanup_sandbox_id" IS NULL
      AND num_nonnulls("replacement_cleanup_node_record_id",
        "replacement_cleanup_node_incarnation", "replacement_cleanup_node_history_id",
        "replacement_cleanup_node_hostname", "replacement_cleanup_node_ssh_port",
        "replacement_cleanup_node_ssh_user", "replacement_cleanup_node_host_key_fingerprint",
        "replacement_cleanup_secret_cleanup_version") = 0)
    OR ("replacement_cleanup_sandbox_id" IS NOT NULL AND (
      (num_nonnulls("replacement_cleanup_node_record_id",
        "replacement_cleanup_node_incarnation", "replacement_cleanup_node_history_id",
        "replacement_cleanup_node_hostname", "replacement_cleanup_node_ssh_port",
        "replacement_cleanup_node_ssh_user", "replacement_cleanup_node_host_key_fingerprint",
        "replacement_cleanup_secret_cleanup_version") = 0)
      OR (num_nulls("replacement_cleanup_node_record_id",
        "replacement_cleanup_node_incarnation", "replacement_cleanup_node_history_id",
        "replacement_cleanup_node_hostname", "replacement_cleanup_node_ssh_port",
        "replacement_cleanup_node_ssh_user",
        "replacement_cleanup_node_host_key_fingerprint") = 0
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
    ))
  ) IS TRUE);
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  DROP CONSTRAINT IF EXISTS "agent_sandboxes_replacement_cleanup_locator_check";
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  ADD CONSTRAINT "agent_sandboxes_replacement_cleanup_locator_check" CHECK ((
    (num_nonnulls("replacement_cleanup_sandbox_id", "replacement_cleanup_node_id",
      "replacement_cleanup_node_record_id", "replacement_cleanup_node_incarnation",
      "replacement_cleanup_node_history_id", "replacement_cleanup_node_hostname",
      "replacement_cleanup_node_ssh_port", "replacement_cleanup_node_ssh_user",
      "replacement_cleanup_node_host_key_fingerprint", "replacement_cleanup_secret_cleanup_version",
      "replacement_cleanup_container_name", "replacement_cleanup_attempt_id",
      "replacement_cleanup_container_id", "replacement_cleanup_vpn_node_id",
      "replacement_cleanup_vpn_node_name", "replacement_cleanup_preserved_vpn_node_id",
      "replacement_cleanup_vpn_registration_started_at", "replacement_cleanup_allocation_counted",
      "replacement_cleanup_created_at") = 0)
    OR ("replacement_cleanup_sandbox_id" IS NOT NULL
      AND "replacement_cleanup_node_id" IS NOT NULL
      AND "replacement_cleanup_container_name" IS NOT NULL
      AND "replacement_cleanup_allocation_counted" IS NOT NULL
      AND "replacement_cleanup_created_at" IS NOT NULL
      AND ((num_nonnulls("replacement_cleanup_node_record_id",
          "replacement_cleanup_node_incarnation", "replacement_cleanup_node_history_id",
          "replacement_cleanup_node_hostname", "replacement_cleanup_node_ssh_port",
          "replacement_cleanup_node_ssh_user", "replacement_cleanup_node_host_key_fingerprint",
          "replacement_cleanup_secret_cleanup_version") = 0)
        OR (num_nulls("replacement_cleanup_node_record_id",
          "replacement_cleanup_node_incarnation", "replacement_cleanup_node_history_id",
          "replacement_cleanup_node_hostname", "replacement_cleanup_node_ssh_port",
          "replacement_cleanup_node_ssh_user",
          "replacement_cleanup_node_host_key_fingerprint") = 0
          AND btrim("replacement_cleanup_node_hostname") <> ''
          AND "replacement_cleanup_node_ssh_port" BETWEEN 1 AND 65535
          AND btrim("replacement_cleanup_node_ssh_user") <> ''
          AND btrim("replacement_cleanup_node_host_key_fingerprint") <> ''))
      AND (("replacement_cleanup_attempt_id" IS NOT NULL
          AND (("replacement_cleanup_node_record_id" IS NULL
              AND "replacement_cleanup_secret_cleanup_version" IS NULL)
            OR ("replacement_cleanup_node_record_id" IS NOT NULL
              AND "replacement_cleanup_secret_cleanup_version" = 1))
          AND ((num_nonnulls("replacement_cleanup_vpn_node_id",
                "replacement_cleanup_vpn_node_name", "replacement_cleanup_preserved_vpn_node_id",
                "replacement_cleanup_vpn_registration_started_at") = 0)
            OR ("replacement_cleanup_vpn_node_name" IS NOT NULL
              AND "replacement_cleanup_vpn_registration_started_at" IS NOT NULL)))
        OR ("replacement_cleanup_secret_cleanup_version" IS NULL
          AND (("replacement_cleanup_node_record_id" IS NULL
              AND "replacement_cleanup_attempt_id" IS NULL
              AND "replacement_cleanup_container_id" IS NULL)
            OR ("replacement_cleanup_node_record_id" IS NOT NULL
              AND "replacement_cleanup_attempt_id" IS NOT NULL
              AND "replacement_cleanup_container_id" ~ '^[0-9a-f]{64}$'))
          AND "replacement_cleanup_vpn_node_name" IS NULL
          AND "replacement_cleanup_preserved_vpn_node_id" IS NULL
          AND "replacement_cleanup_vpn_registration_started_at" IS NULL
          AND "replacement_cleanup_allocation_counted" IS TRUE)))
  ) IS TRUE);
