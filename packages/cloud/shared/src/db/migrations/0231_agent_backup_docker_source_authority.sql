-- Typed Robot/Cloud source identity. Existing weak node registrations remain all-null and
-- therefore ineligible for manifest-v3 capture until host-key-verified attestation completes.

ALTER TABLE "docker_nodes"
  ADD COLUMN IF NOT EXISTS "fleet_kind" text,
  ADD COLUMN IF NOT EXISTS "infrastructure_provider" text,
  ADD COLUMN IF NOT EXISTS "provider_server_id" text,
  ADD COLUMN IF NOT EXISTS "node_incarnation" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "docker_nodes_provider_server_uidx"
  ON "docker_nodes" ("infrastructure_provider", "provider_server_id")
  WHERE "provider_server_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "docker_nodes_node_incarnation_uidx"
  ON "docker_nodes" ("node_incarnation")
  WHERE "node_incarnation" IS NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'docker_nodes_backup_source_authority_shape_check'
      AND conrelid = 'docker_nodes'::regclass
  ) THEN
    ALTER TABLE "docker_nodes" ADD CONSTRAINT
      "docker_nodes_backup_source_authority_shape_check" CHECK (((
        "fleet_kind" IS NULL
        AND "infrastructure_provider" IS NULL
        AND "provider_server_id" IS NULL
        AND "node_incarnation" IS NULL
      ) OR (
        "infrastructure_provider" = 'hetzner'
        AND ("node_incarnation" IS NULL OR (
          "host_key_fingerprint" IS NOT NULL
          AND btrim("host_key_fingerprint") <> ''
        ))
        AND (
          ("fleet_kind" = 'robot' AND "provider_server_id" IS NULL)
          OR (
            "fleet_kind" = 'cloud'
            AND "provider_server_id" IS NOT NULL
            AND CASE
              WHEN "provider_server_id" ~ '^[1-9][0-9]{0,19}$'
                THEN "provider_server_id"::numeric <= 18446744073709551615
              ELSE false
            END
          )
        )
      )) IS TRUE) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "docker_nodes"
  VALIDATE CONSTRAINT "docker_nodes_backup_source_authority_shape_check";
