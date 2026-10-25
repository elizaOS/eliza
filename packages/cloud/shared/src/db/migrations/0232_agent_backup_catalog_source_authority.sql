-- Bind each new catalogue row to a typed node boot and immutable Docker container id.

ALTER TABLE "agent_sandbox_backups"
  ADD COLUMN IF NOT EXISTS "source_provider" text,
  ADD COLUMN IF NOT EXISTS "source_node_record_id" uuid,
  ADD COLUMN IF NOT EXISTS "source_node_id" text,
  ADD COLUMN IF NOT EXISTS "source_node_incarnation" uuid,
  ADD COLUMN IF NOT EXISTS "source_provider_server_id" text,
  ADD COLUMN IF NOT EXISTS "source_provider_handle" text,
  ADD COLUMN IF NOT EXISTS "source_container_id" text;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_sandbox_backups_catalog_v2_source_check'
      AND conrelid = 'agent_sandbox_backups'::regclass
  ) THEN
    ALTER TABLE "agent_sandbox_backups" ADD CONSTRAINT
      "agent_sandbox_backups_catalog_v2_source_check" CHECK ((
        "catalog_version" IS DISTINCT FROM 2 OR (
          "source_provider" IN ('operator-onboarded', 'hetzner-cloud')
          AND "source_node_record_id" IS NOT NULL
          AND "source_node_id" IS NOT NULL AND btrim("source_node_id") <> ''
          AND "source_provider_handle" IS NOT NULL AND btrim("source_provider_handle") <> ''
          AND "source_container_id" ~ '^[0-9a-f]{64}$'
          AND "source_provider_handle" <> "source_container_id"
          AND "retention_reason" IS NOT NULL AND "retention_until" IS NOT NULL
        )
      ) IS TRUE) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_sandbox_backups_catalog_v2_source_authority_check'
      AND conrelid = 'agent_sandbox_backups'::regclass
  ) THEN
    ALTER TABLE "agent_sandbox_backups" ADD CONSTRAINT
      "agent_sandbox_backups_catalog_v2_source_authority_check" CHECK ((
        "catalog_version" IS DISTINCT FROM 2 OR (
          "source_node_incarnation" IS NOT NULL
          AND (
            ("source_provider" = 'operator-onboarded'
              AND "source_provider_server_id" IS NULL)
            OR ("source_provider" = 'hetzner-cloud'
              AND "source_provider_server_id" ~ '^[1-9][0-9]{0,19}$'
              AND "source_provider_server_id"::numeric <= 18446744073709551615)
          )
        )
      ) IS TRUE) NOT VALID;
  END IF;
END $$;
