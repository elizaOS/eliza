-- Refuse unknown legacy restore routes before validating the endpoint contract.
DO $endpoint_preflight$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "agent_activation_publications"
    WHERE "purpose" = 'restore'
      AND ("endpoint_envelope" IS NULL OR "endpoint_sha256" IS NULL)
  ) THEN
    RAISE EXCEPTION 'restore endpoint contract requires an explicit publication backfill'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "agent_sandboxes"
    WHERE "activation_purpose" = 'restore'
      AND "activation_phase" IN ('restart_attested', 'active')
      AND ("activation_endpoint_envelope" IS NULL OR "activation_endpoint_sha256" IS NULL)
  ) THEN
    RAISE EXCEPTION 'restore endpoint contract requires an explicit active-sandbox backfill'
      USING ERRCODE = '23514';
  END IF;
END;
$endpoint_preflight$;
--> statement-breakpoint
ALTER TABLE "agent_backup_restore_operations" VALIDATE CONSTRAINT "agent_backup_restore_operations_endpoint_v1_check";
--> statement-breakpoint
ALTER TABLE "agent_sandboxes" VALIDATE CONSTRAINT "agent_sandboxes_activation_endpoint_v1_check";
--> statement-breakpoint
ALTER TABLE "agent_activation_publications" VALIDATE CONSTRAINT "agent_activation_publications_endpoint_v1_check";
