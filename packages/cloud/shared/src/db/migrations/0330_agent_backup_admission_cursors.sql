-- Adds dedicated tenant/exact-occurrence fairness authorities without locking hot lifecycle rows.

ALTER TABLE "agent_sandbox_backups"
  ADD COLUMN IF NOT EXISTS "source_node_history_id" uuid;
--> statement-breakpoint
-- A node boot UUID may be re-armed as A1 -> B -> A2 with an identical typed
-- vector. No legacy backup column records which append-only occurrence was
-- observed, and transaction-stable created_at cannot establish causality
-- against clock_timestamp() attestations. Never guess this authority.
DO $$
DECLARE
  observed_at timestamp with time zone := clock_timestamp();
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_sandbox_backups" AS backup
    WHERE backup."catalog_version" = 2
      AND backup."source_node_history_id" IS NULL
      AND (
        backup."catalog_state" IN ('scheduled', 'capturing')
        OR (
          backup."catalog_state" = 'failed_retryable'
          AND backup."catalog_resume_state" IN ('scheduled', 'capturing')
        )
      )
  ) THEN
    RAISE EXCEPTION
      'catalog v2 capture rows require explicit source occurrence reconciliation before admission cutover'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT backup."catalog_organization_id"
    FROM "agent_sandbox_backups" AS backup
    WHERE backup."catalog_version" = 2
      AND backup."catalog_organization_id" IS NOT NULL
      AND backup."catalog_lease_expires_at" > observed_at
    GROUP BY backup."catalog_organization_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'catalog v2 active tenant lanes require reconciliation before admission cutover'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT backup."source_node_history_id"
    FROM "agent_sandbox_backups" AS backup
    WHERE backup."catalog_version" = 2
      AND backup."source_node_history_id" IS NOT NULL
      AND backup."catalog_lease_expires_at" > observed_at
      AND (
        backup."catalog_state" IN ('scheduled', 'capturing')
        OR (
          backup."catalog_state" = 'failed_retryable'
          AND backup."catalog_resume_state" IN ('scheduled', 'capturing')
        )
      )
    GROUP BY backup."source_node_history_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'catalog v2 active source-node lanes require reconciliation before admission cutover'
      USING ERRCODE = '55000';
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_sandbox_backups_source_node_occurrence_fkey'
  ) THEN
    ALTER TABLE "agent_sandbox_backups"
      ADD CONSTRAINT "agent_sandbox_backups_source_node_occurrence_fkey"
      FOREIGN KEY (
        "source_node_history_id", "source_node_record_id", "source_node_incarnation"
      ) REFERENCES "agent_node_incarnation_histories" (
        "id", "docker_node_record_id", "node_incarnation"
      ) ON DELETE RESTRICT;
  END IF;
END
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_sandbox_backups_capture_source_occurrence_check'
  ) THEN
    ALTER TABLE "agent_sandbox_backups"
      ADD CONSTRAINT "agent_sandbox_backups_capture_source_occurrence_check"
      CHECK ((
        "catalog_version" IS DISTINCT FROM 2
        OR "source_node_history_id" IS NOT NULL
        OR NOT (
          "catalog_state" IN ('scheduled', 'capturing')
          OR (
            "catalog_state" = 'failed_retryable'
            AND "catalog_resume_state" IN ('scheduled', 'capturing')
          )
        )
      ) IS TRUE);
  END IF;
END
$$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_organization_admission_cursors" (
  "organization_id" uuid PRIMARY KEY
    REFERENCES "organizations"("id") ON DELETE CASCADE,
  "cursor_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_backup_node_admission_cursors" (
  "node_history_id" uuid PRIMARY KEY
    REFERENCES "agent_node_incarnation_histories"("id") ON DELETE RESTRICT,
  "cursor_at" timestamp with time zone,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
INSERT INTO "agent_backup_organization_admission_cursors" ("organization_id")
SELECT DISTINCT "catalog_organization_id"
FROM "agent_sandbox_backups"
WHERE "catalog_version" = 2 AND "catalog_organization_id" IS NOT NULL
ON CONFLICT ("organization_id") DO NOTHING;
--> statement-breakpoint
-- A publication lease may legitimately be in flight during cutover. Capture
-- leases were rejected above because their exact occurrence is unknowable;
-- seed the tenant turn for any remaining active legacy publication.
WITH observed AS MATERIALIZED (
  SELECT clock_timestamp() AS at
)
UPDATE "agent_backup_organization_admission_cursors" AS cursor
SET "cursor_at" = observed.at, "updated_at" = observed.at
FROM observed
WHERE cursor."cursor_at" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "agent_sandbox_backups" AS active
    WHERE active."catalog_version" = 2
      AND active."catalog_organization_id" = cursor."organization_id"
      AND active."catalog_lease_expires_at" > observed.at
  );
--> statement-breakpoint
INSERT INTO "agent_backup_node_admission_cursors" ("node_history_id")
SELECT DISTINCT "source_node_history_id"
FROM "agent_sandbox_backups"
WHERE "catalog_version" = 2 AND "source_node_history_id" IS NOT NULL
ON CONFLICT ("node_history_id") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "bind_agent_backup_admission_authorities"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  exact_history_id uuid;
BEGIN
  IF NEW."catalog_version" IS DISTINCT FROM 2 THEN
    RETURN NEW;
  END IF;

  SELECT history."id"
  INTO exact_history_id
  FROM "docker_nodes" AS node
  JOIN "agent_node_incarnation_histories" AS history
    ON history."id" = node."current_node_history_id"
    AND history."docker_node_record_id" = node."id"
    AND history."node_incarnation" = node."node_incarnation"
    AND history."node_id" = node."node_id"
    AND history."fleet_kind" = node."fleet_kind"
    AND history."infrastructure_provider" = node."infrastructure_provider"
    AND history."provider_server_id" IS NOT DISTINCT FROM node."provider_server_id"
    AND history."host_key_fingerprint" = node."host_key_fingerprint"
  WHERE node."id" = NEW."source_node_record_id"
    AND node."node_id" = NEW."source_node_id"
    AND node."node_incarnation" = NEW."source_node_incarnation"
    AND node."infrastructure_provider" = 'hetzner'
    AND btrim(node."host_key_fingerprint") <> ''
    AND (
      (NEW."source_provider" = 'operator-onboarded'
        AND NEW."source_provider_server_id" IS NULL
        AND node."fleet_kind" = 'robot'
        AND node."provider_server_id" IS NULL)
      OR
      (NEW."source_provider" = 'hetzner-cloud'
        AND node."fleet_kind" = 'cloud'
        AND node."provider_server_id" = NEW."source_provider_server_id")
    )
  FOR NO KEY UPDATE OF node;

  IF exact_history_id IS NULL THEN
    RAISE EXCEPTION 'catalog v2 backup source occurrence is not current';
  END IF;
  IF NEW."source_node_history_id" IS NULL THEN
    NEW."source_node_history_id" := exact_history_id;
  ELSIF NEW."source_node_history_id" IS DISTINCT FROM exact_history_id THEN
    RAISE EXCEPTION 'catalog v2 backup source occurrence changed before insert';
  END IF;

  INSERT INTO "agent_backup_organization_admission_cursors" ("organization_id")
  VALUES (NEW."catalog_organization_id")
  ON CONFLICT ("organization_id") DO NOTHING;
  INSERT INTO "agent_backup_node_admission_cursors" ("node_history_id")
  VALUES (NEW."source_node_history_id")
  ON CONFLICT ("node_history_id") DO NOTHING;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandbox_backups_bind_admission_authorities"
  ON "agent_sandbox_backups";
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_backups_bind_admission_authorities"
BEFORE INSERT ON "agent_sandbox_backups"
FOR EACH ROW
EXECUTE FUNCTION "bind_agent_backup_admission_authorities"();
--> statement-breakpoint
-- The tenant/agent/sandbox lane and full source vector attached at reservation
-- are write-once. The composite FK protects the occurrence's record/incarnation
-- linkage, while this guard also prevents replacing it with another valid
-- A1 -> B -> A2 history row (or erasing it).
-- Legacy publication rows deliberately retain NULL: they do not consume a
-- source-node lane and cannot be moved back into capture states by the CHECK.
CREATE OR REPLACE FUNCTION "preserve_agent_backup_admission_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."catalog_version" IS DISTINCT FROM 2
    AND NEW."catalog_version" = 2
  THEN
    RAISE EXCEPTION 'catalog v2 backup admission identity must be created by insert'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."catalog_version" = 2
    AND (
      NEW."catalog_version" IS DISTINCT FROM OLD."catalog_version"
      OR NEW."catalog_organization_id" IS DISTINCT FROM OLD."catalog_organization_id"
      OR NEW."catalog_agent_id" IS DISTINCT FROM OLD."catalog_agent_id"
      OR NEW."sandbox_record_id" IS DISTINCT FROM OLD."sandbox_record_id"
      OR NEW."source_node_history_id" IS DISTINCT FROM OLD."source_node_history_id"
      OR NEW."source_node_record_id" IS DISTINCT FROM OLD."source_node_record_id"
      OR NEW."source_node_id" IS DISTINCT FROM OLD."source_node_id"
      OR NEW."source_node_incarnation" IS DISTINCT FROM OLD."source_node_incarnation"
      OR NEW."source_provider" IS DISTINCT FROM OLD."source_provider"
      OR NEW."source_provider_server_id" IS DISTINCT FROM OLD."source_provider_server_id"
      OR NEW."source_provider_handle" IS DISTINCT FROM OLD."source_provider_handle"
      OR NEW."source_container_id" IS DISTINCT FROM OLD."source_container_id"
    )
  THEN
    RAISE EXCEPTION 'catalog v2 backup admission identity is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandbox_backups_preserve_admission_identity"
  ON "agent_sandbox_backups";
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_backups_preserve_admission_identity"
BEFORE UPDATE OF
  "catalog_version", "catalog_organization_id", "catalog_agent_id",
  "sandbox_record_id", "source_node_history_id", "source_node_record_id",
  "source_node_id", "source_node_incarnation", "source_provider",
  "source_provider_server_id", "source_provider_handle", "source_container_id"
ON "agent_sandbox_backups"
FOR EACH ROW
EXECUTE FUNCTION "preserve_agent_backup_admission_identity"();
--> statement-breakpoint
-- During a rolling deployment, old binaries do not know the admission lanes.
-- The table ALTER above drains their in-flight writes before this trigger is
-- visible. Afterwards they may settle/release existing work, but only protocol
-- v2 may activate or extend a lease.
CREATE OR REPLACE FUNCTION "require_agent_backup_admission_protocol"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  observed_at timestamp with time zone := clock_timestamp();
BEGIN
  IF NEW."catalog_version" IS DISTINCT FROM 2
    OR NEW."catalog_lease_owner" IS NULL
    OR NEW."catalog_lease_generation" IS NULL
    OR NEW."catalog_lease_expires_at" IS NULL
  THEN
    RETURN NEW;
  END IF;

  IF (
      OLD."catalog_lease_owner" IS DISTINCT FROM NEW."catalog_lease_owner"
      OR OLD."catalog_lease_generation" IS DISTINCT FROM NEW."catalog_lease_generation"
      OR OLD."catalog_lease_expires_at" IS NULL
      OR OLD."catalog_lease_expires_at" <= observed_at
      OR NEW."catalog_lease_expires_at" > OLD."catalog_lease_expires_at"
    )
    AND current_setting('eliza.agent_backup_admission_protocol', true)
      IS DISTINCT FROM '2'
  THEN
    RAISE EXCEPTION 'catalog v2 lease activation requires backup admission protocol 2'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandbox_backups_require_admission_protocol"
  ON "agent_sandbox_backups";
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_backups_require_admission_protocol"
BEFORE UPDATE OF
  "catalog_lease_owner", "catalog_lease_generation", "catalog_lease_expires_at"
ON "agent_sandbox_backups"
FOR EACH ROW
EXECUTE FUNCTION "require_agent_backup_admission_protocol"();
