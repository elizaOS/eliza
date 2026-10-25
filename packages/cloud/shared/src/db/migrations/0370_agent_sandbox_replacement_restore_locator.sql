-- Admit the attempt-scoped exact-restore container name only when the complete
-- twelve-field restore authority is present. Legacy replacement names remain
-- unchanged, and partial restore authority remains rejected by the existing
-- restore-shape constraint.

ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT "agent_sandbox_replacement_attempts_restore_shape_check",
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_restore_shape_check" CHECK ((
    num_nonnulls(
      "restore_lease_id", "restore_backup_id", "restore_attempt_id",
      "restore_lease_owner_id", "restore_lease_generation", "restore_catalog_epoch",
      "restore_copy_role", "restore_operation_id", "restore_source_activation_generation",
      "restore_source_lifecycle_revision", "restore_manifest_sha256",
      "restore_lease_expires_at") = 0
    OR (num_nonnulls(
      "restore_lease_id", "restore_backup_id", "restore_attempt_id",
      "restore_lease_owner_id", "restore_lease_generation", "restore_catalog_epoch",
      "restore_copy_role", "restore_operation_id", "restore_source_activation_generation",
      "restore_source_lifecycle_revision", "restore_manifest_sha256",
      "restore_lease_expires_at") = 12
      AND btrim("restore_lease_owner_id") = "restore_lease_owner_id"
      AND octet_length("restore_lease_owner_id") BETWEEN 1 AND 255
      AND "restore_catalog_epoch" >= 0
      AND "restore_copy_role" IN ('primary', 'secondary')
      AND "restore_source_lifecycle_revision" BETWEEN 0 AND 18446744073709551615
      AND "restore_manifest_sha256" ~ '^[0-9a-f]{64}$'
      AND "operation_kind" = 'provision'
      AND "activation_generation" = "restore_attempt_id"
      AND "restore_lease_expires_at" > "created_at")) IS TRUE);
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT "agent_sandbox_replacement_attempts_locator_shape_check",
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
      AND ((num_nonnulls(
          "restore_lease_id", "restore_backup_id", "restore_attempt_id",
          "restore_lease_owner_id", "restore_lease_generation", "restore_catalog_epoch",
          "restore_copy_role", "restore_operation_id", "restore_source_activation_generation",
          "restore_source_lifecycle_revision", "restore_manifest_sha256",
          "restore_lease_expires_at") = 0
        AND "locator_container_name" = 'agent-' || "agent_id"::text)
      OR (num_nonnulls(
          "restore_lease_id", "restore_backup_id", "restore_attempt_id",
          "restore_lease_owner_id", "restore_lease_generation", "restore_catalog_epoch",
          "restore_copy_role", "restore_operation_id", "restore_source_activation_generation",
          "restore_source_lifecycle_revision", "restore_manifest_sha256",
          "restore_lease_expires_at") = 12
        AND "locator_container_name" =
          'agent-restore-' || "agent_id"::text || '-' || "restore_attempt_id"::text))
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
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD COLUMN "provider_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_provider_start_shape_check" CHECK ((
    (
      (
        "restore_attempt_id" IS NULL AND "provider_started_at" IS NULL
      ) OR (
        "restore_attempt_id" IS NOT NULL
        AND (
          "provider_started_at" IS NULL
          OR (
            "locator_recorded_at" IS NOT NULL
            AND "provider_started_at" >= "locator_recorded_at"
          )
        )
      )
      )
      AND (
        "restore_attempt_id" IS NULL
        OR "locator_container_id" IS NULL
        OR "provider_started_at" IS NOT NULL
      )
      AND (
        "restore_attempt_id" IS NULL
        OR "provider_succeeded_at" IS NULL
        OR "provider_started_at" IS NOT NULL
      )
      AND (
        "provider_started_at" IS NULL
        OR "provider_succeeded_at" IS NULL
        OR "provider_succeeded_at" >= "provider_started_at"
      )
      AND (
        "provider_started_at" IS NULL
        OR "cleanup_proven_at" IS NULL
        OR "cleanup_proven_at" >= "provider_started_at"
      )
    ) IS TRUE
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_sandbox_replacement_provider_start"()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF OLD."provider_started_at" IS NOT NULL
     AND NEW."provider_started_at" IS DISTINCT FROM OLD."provider_started_at" THEN
    RAISE EXCEPTION 'replacement provider start marker is immutable';
  END IF;

  IF OLD."provider_started_at" IS NULL
     AND NEW."provider_started_at" IS NOT NULL
     AND (
       OLD."state" <> 'in_flight_unresolved'
       OR OLD."restore_attempt_id" IS NULL
       OR OLD."locator_recorded_at" IS NULL
       OR OLD."locator_container_id" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'replacement provider start requires unresolved exact restore intent';
  END IF;

  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
-- A provider-settled candidate that is subsequently removed must not leave the
-- restore operation pointing at the deleted container. This is the sole
-- compensating rewind: the exact provider and cleanup receipts must already be
-- durable in the same transaction, and every other operation byte is frozen.
CREATE OR REPLACE FUNCTION "guard_agent_backup_restore_operation"() RETURNS trigger
LANGUAGE plpgsql AS $operation_guard$
DECLARE
  ordinals CONSTANT text[] := ARRAY['reserved','vault_seeded','container_created','restoring',
    'committed','restart_attested','probed','published','finalized'];
  old_rank integer;
  new_rank integer;
  exact_cleanup_rearm boolean := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'restore operation authority cannot be deleted: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;

  exact_cleanup_rearm :=
    OLD."phase" = 'container_created'
    AND NEW."phase" = 'vault_seeded'
    AND OLD."expected_container_id" IS NOT NULL
    AND NEW."expected_container_id" IS NULL
    AND OLD."claim_owner" IS NOT NULL
    AND OLD."claim_generation" IS NOT NULL
    AND OLD."claim_expires_at" IS NOT NULL
    AND NEW."claim_owner" IS NULL
    AND NEW."claim_generation" IS NULL
    AND NEW."claim_expires_at" IS NULL
    AND (to_jsonb(NEW) - ARRAY[
      'phase', 'expected_container_id', 'claim_owner', 'claim_generation',
      'claim_expires_at', 'updated_at'
    ]::text[]) IS NOT DISTINCT FROM (to_jsonb(OLD) - ARRAY[
      'phase', 'expected_container_id', 'claim_owner', 'claim_generation',
      'claim_expires_at', 'updated_at'
    ]::text[])
    AND EXISTS (
      SELECT 1
      FROM "agent_sandbox_replacement_attempts" AS cleanup
      WHERE cleanup."organization_id" = OLD."organization_id"
        AND cleanup."agent_id" = OLD."agent_id"
        AND cleanup."operation_kind" = 'provision'
        AND cleanup."activation_generation" = OLD."restore_attempt_id"
        AND cleanup."state" = 'cleanup_proven'
        AND cleanup."provider_succeeded_at" IS NOT NULL
        AND cleanup."provider_receipt_digest" IS NOT NULL
        AND cleanup."cleanup_proven_at" IS NOT NULL
        AND cleanup."cleanup_receipt_digest" IS NOT NULL
        AND cleanup."lifecycle_committed_at" IS NULL
        AND cleanup."lifecycle_receipt_digest" IS NULL
        AND cleanup."restore_lease_id" = OLD."lease_id"
        AND cleanup."restore_backup_id" = OLD."backup_id"
        AND cleanup."restore_attempt_id" = OLD."restore_attempt_id"
        AND cleanup."restore_lease_owner_id" = OLD."lease_owner_id"
        AND cleanup."restore_lease_generation" = OLD."lease_generation"
        AND cleanup."restore_catalog_epoch" = OLD."catalog_epoch"
        AND cleanup."restore_copy_role" = OLD."copy_role"
        AND cleanup."restore_operation_id" = OLD."expected_operation_id"
        AND cleanup."restore_source_activation_generation"
          = OLD."expected_activation_generation"
        AND cleanup."restore_source_lifecycle_revision"
          = OLD."expected_lifecycle_revision"
        AND cleanup."restore_manifest_sha256" = OLD."expected_manifest_sha256"
        AND cleanup."locator_sandbox_id" =
          'agent-restore-' || OLD."agent_id"::text || '-' || OLD."restore_attempt_id"::text
        AND cleanup."locator_container_name" = cleanup."locator_sandbox_id"
        AND cleanup."locator_container_id" = OLD."expected_container_id"
        AND cleanup."locator_node_record_id" = OLD."expected_node_record_id"
        AND cleanup."locator_node_incarnation" = OLD."expected_node_incarnation"
        AND cleanup."locator_node_history_id" = OLD."expected_node_history_id"
        AND cleanup."locator_allocation_counted" = TRUE
    );

  IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
    OR NEW."agent_id" IS DISTINCT FROM OLD."agent_id"
    OR NEW."backup_id" IS DISTINCT FROM OLD."backup_id"
    OR NEW."restore_attempt_id" IS DISTINCT FROM OLD."restore_attempt_id"
    OR NEW."lease_id" IS DISTINCT FROM OLD."lease_id"
    OR NEW."lease_generation" IS DISTINCT FROM OLD."lease_generation"
    OR NEW."expected_operation_id" IS DISTINCT FROM OLD."expected_operation_id"
    OR NEW."expected_manifest_sha256" IS DISTINCT FROM OLD."expected_manifest_sha256"
    OR NEW."expected_activation_generation" IS DISTINCT FROM OLD."expected_activation_generation"
    OR NEW."expected_lifecycle_revision" IS DISTINCT FROM OLD."expected_lifecycle_revision"
    OR NEW."copy_role" IS DISTINCT FROM OLD."copy_role"
    OR NEW."lease_owner_id" IS DISTINCT FROM OLD."lease_owner_id"
    OR NEW."catalog_epoch" IS DISTINCT FROM OLD."catalog_epoch"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'restore operation identity is immutable: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;

  IF (OLD."expected_node_record_id" IS NOT NULL
      AND NEW."expected_node_record_id" IS DISTINCT FROM OLD."expected_node_record_id")
    OR (OLD."expected_node_incarnation" IS NOT NULL
      AND NEW."expected_node_incarnation" IS DISTINCT FROM OLD."expected_node_incarnation")
    OR (OLD."expected_container_id" IS NOT NULL
      AND NEW."expected_container_id" IS DISTINCT FROM OLD."expected_container_id"
      AND NOT exact_cleanup_rearm)
    OR (OLD."expected_image_digest" IS NOT NULL
      AND NEW."expected_image_digest" IS DISTINCT FROM OLD."expected_image_digest")
    OR (OLD."receipt_digest" IS NOT NULL
      AND NEW."receipt_digest" IS DISTINCT FROM OLD."receipt_digest") THEN
    RAISE EXCEPTION 'restore operation side-effect identity is write-once: %', OLD."id"
      USING ERRCODE = '55000';
  END IF;

  IF OLD."phase" IN ('finalized', 'failed_terminal')
    AND NEW."phase" IS DISTINCT FROM OLD."phase" THEN
    RAISE EXCEPTION 'restore operation % is terminal in phase %', OLD."id", OLD."phase"
      USING ERRCODE = '55000';
  END IF;

  old_rank := array_position(ordinals, OLD."phase");
  new_rank := array_position(ordinals, NEW."phase");
  IF old_rank IS NOT NULL AND new_rank IS NOT NULL AND new_rank < old_rank
    AND NOT exact_cleanup_rearm THEN
    RAISE EXCEPTION 'restore operation % cannot rewind from % to %',
      OLD."id", OLD."phase", NEW."phase" USING ERRCODE = '55000';
  END IF;
  IF old_rank IS NOT NULL AND new_rank IS NOT NULL AND new_rank > old_rank + 1 THEN
    RAISE EXCEPTION 'restore operation % cannot skip from % to %',
      OLD."id", OLD."phase", NEW."phase" USING ERRCODE = '55000';
  END IF;

  IF OLD."phase" = 'failed_retryable' AND NEW."phase" NOT IN ('failed_retryable', 'failed_terminal')
    AND NEW."phase" IS DISTINCT FROM OLD."resume_phase" THEN
    RAISE EXCEPTION 'restore operation % must resume %, not %',
      OLD."id", OLD."resume_phase", NEW."phase" USING ERRCODE = '55000';
  END IF;

  NEW."updated_at" := clock_timestamp();
  RETURN NEW;
END;
$operation_guard$;
--> statement-breakpoint
CREATE TRIGGER "agent_sandbox_replacement_attempts_guard_provider_start"
  BEFORE UPDATE OF "provider_started_at"
  ON "agent_sandbox_replacement_attempts"
  FOR EACH ROW
  EXECUTE FUNCTION "guard_agent_sandbox_replacement_provider_start"();
--> statement-breakpoint
-- Cleanup is a two-phase fence: cleanup_in_progress commits before any remote
-- tombstone/removal, so a delayed provider-success callback can no longer win
-- after the candidate has been removed.
ALTER TABLE "agent_sandbox_replacement_attempts"
  DROP CONSTRAINT "agent_sandbox_replacement_attempts_settlement_shape_check",
  ADD CONSTRAINT "agent_sandbox_replacement_attempts_settlement_shape_check" CHECK ((
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
    OR ("state" = 'cleanup_in_progress'
      AND "restore_attempt_id" IS NOT NULL
      AND "locator_recorded_at" IS NOT NULL
      AND ("provider_succeeded_at" IS NULL) = ("provider_receipt_digest" IS NULL)
      AND ("provider_succeeded_at" IS NULL
        OR ("locator_container_id" IS NOT NULL
          AND "provider_succeeded_at" >= "locator_container_recorded_at"
          AND "provider_receipt_digest" ~ '^[0-9a-f]{64}$'))
      AND "lifecycle_committed_at" IS NULL
      AND "lifecycle_receipt_digest" IS NULL
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
  ) IS TRUE);
--> statement-breakpoint
DROP INDEX "agent_sandbox_replacement_attempts_active_agent_uidx";
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sandbox_replacement_attempts_active_agent_uidx"
  ON "agent_sandbox_replacement_attempts" ("organization_id", "agent_id")
  WHERE "state" IN ('in_flight_unresolved', 'provider_succeeded', 'cleanup_in_progress');
--> statement-breakpoint
DROP INDEX "agent_sandbox_replacement_attempts_active_generation_uidx";
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sandbox_replacement_attempts_active_generation_uidx"
  ON "agent_sandbox_replacement_attempts"
    ("organization_id", "agent_id", "activation_generation")
  WHERE "state" IN (
    'in_flight_unresolved', 'provider_succeeded', 'lifecycle_committed', 'cleanup_in_progress'
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_sandbox_replacement_attempt_state"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
BEGIN
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
      AND (
        NEW."state" IN ('provider_succeeded', 'cleanup_in_progress')
        OR (NEW."state" = 'cleanup_proven' AND OLD."restore_attempt_id" IS NULL)
      ))
    OR (OLD."state" = 'provider_succeeded'
      AND (
        NEW."state" IN ('lifecycle_committed', 'cleanup_in_progress')
        OR (NEW."state" = 'cleanup_proven' AND OLD."restore_attempt_id" IS NULL)
      ))
    OR (OLD."state" = 'cleanup_in_progress' AND NEW."state" = 'cleanup_proven')
  ) THEN
    RAISE EXCEPTION 'replacement attempt state transition is not monotonic';
  END IF;
  IF OLD."state" = 'in_flight_unresolved' AND NEW."state" = 'provider_succeeded'
    AND (OLD."locator_recorded_at" IS NULL OR OLD."locator_container_id" IS NULL) THEN
    RAISE EXCEPTION 'provider success requires previously durable exact placement';
  END IF;
  RETURN NEW;
END;
$guard$;
