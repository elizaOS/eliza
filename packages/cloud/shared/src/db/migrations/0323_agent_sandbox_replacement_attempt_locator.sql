-- Require a complete, exact Docker-node occurrence before provider evidence can
-- be recorded, while allowing an attempt to begin without a locator.

ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_locator_shape_check" CHECK ((
    num_nonnulls(
      "locator_sandbox_id", "locator_node_id", "locator_container_name",
      "locator_node_record_id", "locator_node_incarnation", "locator_node_history_id",
      "locator_node_hostname", "locator_node_ssh_port", "locator_node_ssh_user",
      "locator_node_host_key_fingerprint", "locator_secret_cleanup_version",
      "locator_allocation_counted", "locator_vpn_node_name",
      "locator_vpn_registration_started_at", "locator_previous_vpn_node_id",
      "locator_recorded_at", "locator_container_id", "locator_container_recorded_at",
      "locator_vpn_node_id", "locator_vpn_recorded_at"
    ) = 0
    OR (
      "locator_sandbox_id" IS NOT NULL
      AND "locator_node_id" IS NOT NULL
      AND "locator_container_name" IS NOT NULL
      AND "locator_node_record_id" IS NOT NULL
      AND "locator_node_incarnation" IS NOT NULL
      AND "locator_node_history_id" IS NOT NULL
      AND "locator_node_hostname" IS NOT NULL
      AND "locator_node_ssh_port" IS NOT NULL
      AND "locator_node_ssh_user" IS NOT NULL
      AND "locator_node_host_key_fingerprint" IS NOT NULL
      AND "locator_secret_cleanup_version" = 1
      AND "locator_allocation_counted" = TRUE
      AND "locator_recorded_at" IS NOT NULL
      AND "locator_sandbox_id" = "locator_container_name"
      AND "locator_container_name" = 'agent-' || "agent_id"::text
      AND btrim("locator_node_id") <> ''
      AND octet_length("locator_node_id") <= 255
      AND btrim("locator_node_hostname") <> ''
      AND octet_length("locator_node_hostname") <= 255
      AND "locator_node_ssh_port" BETWEEN 1 AND 65535
      AND btrim("locator_node_ssh_user") <> ''
      AND octet_length("locator_node_ssh_user") <= 255
      AND btrim("locator_node_host_key_fingerprint") <> ''
      AND octet_length("locator_node_host_key_fingerprint") <= 1024
      AND "locator_recorded_at" >= "created_at"
      AND ("locator_container_id" IS NULL) = ("locator_container_recorded_at" IS NULL)
      AND ("locator_container_id" IS NULL
        OR ("locator_container_id" ~ '^[0-9a-f]{12,64}$'
          AND "locator_container_recorded_at" >= "locator_recorded_at"))
      AND ("locator_vpn_node_name" IS NULL)
        = ("locator_vpn_registration_started_at" IS NULL)
      AND ("locator_vpn_node_name" IS NULL
        OR (btrim("locator_vpn_node_name") <> ''
          AND octet_length("locator_vpn_node_name") <= 255))
      AND ("locator_previous_vpn_node_id" IS NULL
        OR ("locator_vpn_node_name" IS NOT NULL
          AND CASE
            WHEN "locator_previous_vpn_node_id" ~ '^[1-9][0-9]{0,19}$'
              THEN "locator_previous_vpn_node_id"::numeric <= 18446744073709551615
            ELSE FALSE
          END))
      AND ("locator_vpn_node_id" IS NULL) = ("locator_vpn_recorded_at" IS NULL)
      AND ("locator_vpn_node_id" IS NULL
        OR ("locator_container_id" IS NOT NULL
          AND "locator_vpn_node_name" IS NOT NULL
          AND "locator_vpn_node_id" IS DISTINCT FROM "locator_previous_vpn_node_id"
          AND "locator_vpn_recorded_at" >= "locator_container_recorded_at"
          AND CASE
            WHEN "locator_vpn_node_id" ~ '^[1-9][0-9]{0,19}$'
              THEN "locator_vpn_node_id"::numeric <= 18446744073709551615
            ELSE FALSE
          END))
    )
  ) IS TRUE);
