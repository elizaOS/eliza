-- Durable one-shot authority for sandbox replacement provider effects. The
-- table is append-only for the owner's lifetime: an ambiguous create remains
-- fenced until exact cleanup is proven. Terminal non-restore history may be
-- erased only by its organization's owning cascade; other retention authorities
-- can still reject organization deletion.

CREATE TABLE IF NOT EXISTS "agent_sandbox_replacement_attempts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL,
  "operation_kind" text NOT NULL,
  "lifecycle_revision" numeric(20, 0) NOT NULL,
  "activation_generation" uuid NOT NULL,
  "lifecycle_job_id" uuid,
  "lifecycle_execution_generation" uuid,
  "restore_lease_id" uuid,
  "restore_backup_id" uuid,
  "restore_attempt_id" uuid,
  "restore_lease_owner_id" text,
  "restore_lease_generation" uuid,
  "restore_catalog_epoch" bigint,
  "restore_copy_role" text,
  "restore_operation_id" uuid,
  "restore_source_activation_generation" uuid,
  "restore_source_lifecycle_revision" numeric(20, 0),
  "restore_manifest_sha256" text,
  "restore_lease_expires_at" timestamptz,
  "state" text DEFAULT 'in_flight_unresolved' NOT NULL,
  "locator_sandbox_id" text,
  "locator_node_id" text,
  "locator_container_name" text,
  "locator_node_record_id" uuid,
  "locator_node_hostname" text,
  "locator_node_ssh_port" integer,
  "locator_node_ssh_user" text,
  "locator_node_host_key_fingerprint" text,
  "locator_secret_cleanup_version" integer,
  "locator_allocation_counted" boolean,
  "locator_vpn_node_name" text,
  "locator_vpn_registration_started_at" timestamptz,
  "locator_previous_vpn_node_id" text,
  "locator_recorded_at" timestamptz,
  "locator_container_id" text,
  "locator_container_recorded_at" timestamptz,
  "locator_vpn_node_id" text,
  "locator_vpn_recorded_at" timestamptz,
  "provider_succeeded_at" timestamptz,
  "provider_receipt_digest" text,
  "lifecycle_committed_at" timestamptz,
  "lifecycle_receipt_digest" text,
  "cleanup_proven_at" timestamptz,
  "cleanup_receipt_digest" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "agent_sandbox_replacement_attempts_restore_lease_fkey" FOREIGN KEY (
    "restore_lease_id", "organization_id", "agent_id", "restore_backup_id",
    "restore_attempt_id", "restore_lease_owner_id", "restore_lease_generation",
    "restore_catalog_epoch", "restore_copy_role", "restore_operation_id",
    "restore_source_activation_generation", "restore_source_lifecycle_revision",
    "restore_manifest_sha256"
  ) REFERENCES "agent_backup_restore_leases" (
    "id", "organization_id", "agent_id", "backup_id", "restore_attempt_id",
    "owner_id", "generation", "catalog_epoch", "copy_role", "operation_id",
    "activation_generation", "lifecycle_revision", "expected_manifest_sha256"
  ) ON DELETE RESTRICT,
  CONSTRAINT "agent_sandbox_replacement_attempts_operation_kind_check" CHECK (
    "operation_kind" IN ('provision', 'upgrade', 'downgrade')
  ),
  CONSTRAINT "agent_sandbox_replacement_attempts_lifecycle_check" CHECK ((
    "lifecycle_revision" BETWEEN 0 AND 18446744073709551615
    AND (("lifecycle_job_id" IS NULL AND "lifecycle_execution_generation" IS NULL)
      OR ("lifecycle_job_id" IS NOT NULL
        AND "lifecycle_execution_generation" IS NOT NULL))
  ) IS TRUE),
  CONSTRAINT "agent_sandbox_replacement_attempts_restore_shape_check" CHECK ((
    num_nonnulls(
      "restore_lease_id", "restore_backup_id", "restore_attempt_id",
      "restore_lease_owner_id", "restore_lease_generation", "restore_catalog_epoch",
      "restore_copy_role", "restore_operation_id", "restore_source_activation_generation",
      "restore_source_lifecycle_revision", "restore_manifest_sha256",
      "restore_lease_expires_at"
    ) = 0
    OR (num_nonnulls(
      "restore_lease_id", "restore_backup_id", "restore_attempt_id",
      "restore_lease_owner_id", "restore_lease_generation", "restore_catalog_epoch",
      "restore_copy_role", "restore_operation_id", "restore_source_activation_generation",
      "restore_source_lifecycle_revision", "restore_manifest_sha256",
      "restore_lease_expires_at"
    ) = 12
      AND btrim("restore_lease_owner_id") = "restore_lease_owner_id"
      AND octet_length("restore_lease_owner_id") BETWEEN 1 AND 255
      AND "restore_catalog_epoch" >= 0
      AND "restore_copy_role" IN ('primary', 'secondary')
      AND "restore_source_lifecycle_revision" BETWEEN 0 AND 18446744073709551615
      AND "restore_manifest_sha256" ~ '^[0-9a-f]{64}$'
      AND "restore_lease_expires_at" > "created_at")
  ) IS TRUE),
  CONSTRAINT "agent_sandbox_replacement_attempts_locator_shape_check" CHECK ((
    num_nonnulls(
      "locator_sandbox_id", "locator_node_id", "locator_container_name",
      "locator_node_record_id", "locator_node_hostname", "locator_node_ssh_port",
      "locator_node_ssh_user", "locator_node_host_key_fingerprint",
      "locator_secret_cleanup_version", "locator_allocation_counted",
      "locator_vpn_node_name", "locator_vpn_registration_started_at",
      "locator_previous_vpn_node_id", "locator_recorded_at", "locator_container_id",
      "locator_container_recorded_at", "locator_vpn_node_id", "locator_vpn_recorded_at"
    ) = 0
    OR (
      "locator_sandbox_id" IS NOT NULL
      AND "locator_node_id" IS NOT NULL
      AND "locator_container_name" IS NOT NULL
      AND "locator_node_record_id" IS NOT NULL
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
  ) IS TRUE),
  CONSTRAINT "agent_sandbox_replacement_attempts_settlement_shape_check" CHECK ((
    ("state" = 'in_flight_unresolved'
      AND num_nonnulls(
        "provider_succeeded_at", "provider_receipt_digest", "lifecycle_committed_at",
        "lifecycle_receipt_digest", "cleanup_proven_at", "cleanup_receipt_digest"
      ) = 0)
    OR ("state" = 'provider_succeeded'
      AND "locator_recorded_at" IS NOT NULL
      AND "locator_container_id" IS NOT NULL
      AND "provider_succeeded_at" IS NOT NULL
      AND "provider_succeeded_at" >= "locator_container_recorded_at"
      AND ("locator_vpn_node_name" IS NULL OR "locator_vpn_node_id" IS NOT NULL)
      AND ("locator_vpn_recorded_at" IS NULL
        OR "provider_succeeded_at" >= "locator_vpn_recorded_at")
      AND "provider_receipt_digest" ~ '^[0-9a-f]{64}$'
      AND num_nonnulls(
        "lifecycle_committed_at", "lifecycle_receipt_digest",
        "cleanup_proven_at", "cleanup_receipt_digest"
      ) = 0)
    OR ("state" = 'lifecycle_committed'
      AND "provider_succeeded_at" IS NOT NULL
      AND "provider_receipt_digest" ~ '^[0-9a-f]{64}$'
      AND "lifecycle_committed_at" IS NOT NULL
      AND "lifecycle_committed_at" >= "provider_succeeded_at"
      AND "lifecycle_receipt_digest" ~ '^[0-9a-f]{64}$'
      AND "cleanup_proven_at" IS NULL
      AND "cleanup_receipt_digest" IS NULL)
    OR ("state" = 'cleanup_proven'
      AND ("provider_succeeded_at" IS NULL) = ("provider_receipt_digest" IS NULL)
      AND ("provider_receipt_digest" IS NULL
        OR "provider_receipt_digest" ~ '^[0-9a-f]{64}$')
      AND "cleanup_proven_at" IS NOT NULL
      AND "cleanup_proven_at" >= COALESCE(
        "locator_vpn_recorded_at", "locator_container_recorded_at",
        "locator_recorded_at", "created_at"
      )
      AND ("provider_succeeded_at" IS NULL
        OR "cleanup_proven_at" >= "provider_succeeded_at")
      AND "cleanup_receipt_digest" ~ '^[0-9a-f]{64}$'
      AND "lifecycle_committed_at" IS NULL
      AND "lifecycle_receipt_digest" IS NULL)
  ) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_sandbox_replacement_attempts_active_agent_uidx"
  ON "agent_sandbox_replacement_attempts" ("organization_id", "agent_id")
  WHERE "state" IN ('in_flight_unresolved', 'provider_succeeded');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_sandbox_replacement_attempts_active_generation_uidx"
  ON "agent_sandbox_replacement_attempts"
    ("organization_id", "agent_id", "activation_generation")
  WHERE "state" IN ('in_flight_unresolved', 'provider_succeeded', 'lifecycle_committed');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_sandbox_replacement_attempt"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'replacement attempts cannot be truncated';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() = 2
      AND OLD."state" IN ('lifecycle_committed', 'cleanup_proven')
      AND NOT EXISTS (
        SELECT 1 FROM "organizations" WHERE "id" = OLD."organization_id"
      ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'replacement attempts cannot be deleted before terminal owner erasure';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'in_flight_unresolved'
      OR num_nonnulls(
        NEW."locator_sandbox_id", NEW."locator_node_id", NEW."locator_container_name",
        NEW."locator_node_record_id", NEW."locator_node_hostname", NEW."locator_node_ssh_port",
        NEW."locator_node_ssh_user", NEW."locator_node_host_key_fingerprint",
        NEW."locator_secret_cleanup_version", NEW."locator_allocation_counted",
        NEW."locator_vpn_node_name", NEW."locator_vpn_registration_started_at",
        NEW."locator_previous_vpn_node_id", NEW."locator_recorded_at",
        NEW."locator_container_id", NEW."locator_container_recorded_at",
        NEW."locator_vpn_node_id", NEW."locator_vpn_recorded_at",
        NEW."provider_succeeded_at", NEW."provider_receipt_digest",
        NEW."lifecycle_committed_at", NEW."lifecycle_receipt_digest",
        NEW."cleanup_proven_at", NEW."cleanup_receipt_digest"
      ) <> 0 THEN
      RAISE EXCEPTION 'replacement attempt must start before any provider evidence';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."state" IN ('lifecycle_committed', 'cleanup_proven') THEN
    RAISE EXCEPTION 'terminal replacement attempt is immutable';
  END IF;
  IF NEW."updated_at" < OLD."updated_at" THEN
    RAISE EXCEPTION 'replacement attempt timestamp cannot rewind';
  END IF;
  IF ROW(
    OLD."id", OLD."organization_id", OLD."agent_id", OLD."operation_kind",
    OLD."lifecycle_revision", OLD."activation_generation", OLD."lifecycle_job_id",
    OLD."lifecycle_execution_generation", OLD."restore_lease_id", OLD."restore_backup_id",
    OLD."restore_attempt_id", OLD."restore_lease_owner_id", OLD."restore_lease_generation",
    OLD."restore_catalog_epoch", OLD."restore_copy_role", OLD."restore_operation_id",
    OLD."restore_source_activation_generation", OLD."restore_source_lifecycle_revision",
    OLD."restore_manifest_sha256", OLD."restore_lease_expires_at", OLD."created_at"
  ) IS DISTINCT FROM ROW(
    NEW."id", NEW."organization_id", NEW."agent_id", NEW."operation_kind",
    NEW."lifecycle_revision", NEW."activation_generation", NEW."lifecycle_job_id",
    NEW."lifecycle_execution_generation", NEW."restore_lease_id", NEW."restore_backup_id",
    NEW."restore_attempt_id", NEW."restore_lease_owner_id", NEW."restore_lease_generation",
    NEW."restore_catalog_epoch", NEW."restore_copy_role", NEW."restore_operation_id",
    NEW."restore_source_activation_generation", NEW."restore_source_lifecycle_revision",
    NEW."restore_manifest_sha256", NEW."restore_lease_expires_at", NEW."created_at"
  ) THEN
    RAISE EXCEPTION 'replacement attempt identity is immutable';
  END IF;

  IF OLD."locator_recorded_at" IS NULL THEN
    IF NEW."locator_recorded_at" IS NOT NULL
      AND (NEW."locator_container_id" IS NOT NULL OR NEW."locator_vpn_node_id" IS NOT NULL) THEN
      RAISE EXCEPTION 'replacement locator enrichments cannot skip intent';
    END IF;
  ELSIF ROW(
    OLD."locator_sandbox_id", OLD."locator_node_id", OLD."locator_container_name",
    OLD."locator_node_record_id", OLD."locator_node_hostname", OLD."locator_node_ssh_port",
    OLD."locator_node_ssh_user", OLD."locator_node_host_key_fingerprint",
    OLD."locator_secret_cleanup_version", OLD."locator_allocation_counted",
    OLD."locator_vpn_node_name", OLD."locator_vpn_registration_started_at",
    OLD."locator_previous_vpn_node_id", OLD."locator_recorded_at"
  ) IS DISTINCT FROM ROW(
    NEW."locator_sandbox_id", NEW."locator_node_id", NEW."locator_container_name",
    NEW."locator_node_record_id", NEW."locator_node_hostname", NEW."locator_node_ssh_port",
    NEW."locator_node_ssh_user", NEW."locator_node_host_key_fingerprint",
    NEW."locator_secret_cleanup_version", NEW."locator_allocation_counted",
    NEW."locator_vpn_node_name", NEW."locator_vpn_registration_started_at",
    NEW."locator_previous_vpn_node_id", NEW."locator_recorded_at"
  ) THEN
    RAISE EXCEPTION 'replacement locator identity is immutable';
  END IF;

  IF OLD."locator_container_id" IS NULL THEN
    IF NEW."locator_container_id" IS NOT NULL AND OLD."locator_recorded_at" IS NULL THEN
      RAISE EXCEPTION 'replacement Docker enrichment requires durable intent';
    END IF;
  ELSIF ROW(OLD."locator_container_id", OLD."locator_container_recorded_at")
    IS DISTINCT FROM ROW(NEW."locator_container_id", NEW."locator_container_recorded_at") THEN
    RAISE EXCEPTION 'replacement Docker enrichment is immutable';
  END IF;
  IF OLD."locator_vpn_node_id" IS NULL THEN
    IF NEW."locator_vpn_node_id" IS NOT NULL AND OLD."locator_container_id" IS NULL THEN
      RAISE EXCEPTION 'replacement VPN enrichment requires durable Docker identity';
    END IF;
  ELSIF ROW(OLD."locator_vpn_node_id", OLD."locator_vpn_recorded_at")
    IS DISTINCT FROM ROW(NEW."locator_vpn_node_id", NEW."locator_vpn_recorded_at") THEN
    RAISE EXCEPTION 'replacement VPN enrichment is immutable';
  END IF;

  IF OLD."provider_succeeded_at" IS NOT NULL
    AND ROW(OLD."provider_succeeded_at", OLD."provider_receipt_digest")
      IS DISTINCT FROM ROW(NEW."provider_succeeded_at", NEW."provider_receipt_digest") THEN
    RAISE EXCEPTION 'replacement provider receipt is immutable';
  END IF;
  IF OLD."lifecycle_committed_at" IS NOT NULL
    AND ROW(OLD."lifecycle_committed_at", OLD."lifecycle_receipt_digest")
      IS DISTINCT FROM ROW(NEW."lifecycle_committed_at", NEW."lifecycle_receipt_digest") THEN
    RAISE EXCEPTION 'replacement lifecycle receipt is immutable';
  END IF;
  IF OLD."cleanup_proven_at" IS NOT NULL
    AND ROW(OLD."cleanup_proven_at", OLD."cleanup_receipt_digest")
      IS DISTINCT FROM ROW(NEW."cleanup_proven_at", NEW."cleanup_receipt_digest") THEN
    RAISE EXCEPTION 'replacement cleanup receipt is immutable';
  END IF;

  IF NOT (
    NEW."state" = OLD."state"
    OR (OLD."state" = 'in_flight_unresolved'
      AND NEW."state" IN ('provider_succeeded', 'cleanup_proven'))
    OR (OLD."state" = 'provider_succeeded'
      AND NEW."state" IN ('lifecycle_committed', 'cleanup_proven'))
  ) THEN
    RAISE EXCEPTION 'replacement attempt state transition is not monotonic';
  END IF;
  IF OLD."state" = 'in_flight_unresolved' AND NEW."state" = 'provider_succeeded'
    AND (OLD."locator_recorded_at" IS NULL OR OLD."locator_container_id" IS NULL) THEN
    RAISE EXCEPTION 'provider success requires previously durable exact placement';
  END IF;
  IF OLD."state" <> 'in_flight_unresolved'
    AND ROW(
      OLD."locator_sandbox_id", OLD."locator_node_id", OLD."locator_container_name",
      OLD."locator_node_record_id", OLD."locator_node_hostname", OLD."locator_node_ssh_port",
      OLD."locator_node_ssh_user", OLD."locator_node_host_key_fingerprint",
      OLD."locator_secret_cleanup_version", OLD."locator_allocation_counted",
      OLD."locator_vpn_node_name", OLD."locator_vpn_registration_started_at",
      OLD."locator_previous_vpn_node_id", OLD."locator_recorded_at",
      OLD."locator_container_id", OLD."locator_container_recorded_at",
      OLD."locator_vpn_node_id", OLD."locator_vpn_recorded_at"
    ) IS DISTINCT FROM ROW(
      NEW."locator_sandbox_id", NEW."locator_node_id", NEW."locator_container_name",
      NEW."locator_node_record_id", NEW."locator_node_hostname", NEW."locator_node_ssh_port",
      NEW."locator_node_ssh_user", NEW."locator_node_host_key_fingerprint",
      NEW."locator_secret_cleanup_version", NEW."locator_allocation_counted",
      NEW."locator_vpn_node_name", NEW."locator_vpn_registration_started_at",
      NEW."locator_previous_vpn_node_id", NEW."locator_recorded_at",
      NEW."locator_container_id", NEW."locator_container_recorded_at",
      NEW."locator_vpn_node_id", NEW."locator_vpn_recorded_at"
    ) THEN
    RAISE EXCEPTION 'settled replacement locator is immutable';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandbox_replacement_attempts_guard_row"
  ON "agent_sandbox_replacement_attempts";
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_replacement_attempts_guard_row"
  BEFORE INSERT OR UPDATE OR DELETE ON "agent_sandbox_replacement_attempts"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_sandbox_replacement_attempt"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandbox_replacement_attempts_guard_truncate"
  ON "agent_sandbox_replacement_attempts";
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_replacement_attempts_guard_truncate"
  BEFORE TRUNCATE ON "agent_sandbox_replacement_attempts"
  FOR EACH STATEMENT EXECUTE FUNCTION "guard_agent_sandbox_replacement_attempt"();
