LOCK TABLE public."agent_backup_restore_operations", public."agent_sandboxes", public."agent_activation_publications" IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $endpoint_preflight$
DECLARE runtime_contract_installed boolean := EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'agent_backup_restore_operations_runtime_binding' AND tgrelid = 'public.agent_backup_restore_operations'::regclass AND NOT tgisinternal AND tgenabled IN ('O','A') AND tgfoid = pg_catalog.to_regprocedure('public.enforce_agent_restore_endpoint_runtime_binding_v3()') AND (tgtype & 23) = 23) AND EXISTS (SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'agent_activation_publications_endpoint_runtime_binding' AND tgrelid = 'public.agent_activation_publications'::regclass AND NOT tgisinternal AND tgenabled IN ('O','A') AND tgfoid = pg_catalog.to_regprocedure('public.enforce_agent_restore_endpoint_runtime_binding_v3()') AND (tgtype & 7) = 7);
BEGIN
  IF EXISTS (
    SELECT 1 FROM public."agent_activation_publications"
    WHERE "purpose" = 'restore'
      AND ("endpoint_envelope" IS NULL OR "endpoint_sha256" IS NULL)
  ) THEN
    RAISE EXCEPTION 'restore endpoint contract requires an explicit publication backfill'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public."agent_sandboxes"
    WHERE "activation_purpose" = 'restore'
      AND "activation_phase" IN ('restart_attested', 'active')
      AND ((NOT runtime_contract_installed AND ("deleted_at" IS NOT NULL OR "deletion_attempt_id" IS NOT NULL OR "status" IN ('deletion_pending','deletion_failed')))
        OR ("deleted_at" IS NULL AND "deletion_attempt_id" IS NULL AND "status" NOT IN ('deletion_pending','deletion_failed') AND ("activation_endpoint_envelope" IS NULL OR "activation_endpoint_sha256" IS NULL OR "character_id" IS NULL OR "activation_endpoint_envelope"->>'runtimeAgentId' IS DISTINCT FROM "character_id"::text)))
  ) THEN
    RAISE EXCEPTION 'restore endpoint contract requires an explicit identity-bound active-sandbox backfill'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM public."agent_backup_restore_operations" WHERE "expected_endpoint_envelope" IS NULL AND ("phase" IN ('container_created','restoring','committed','restart_attested','probed','published','finalized') OR ("phase" = 'failed_retryable' AND "resume_phase" IN ('container_created','restoring','committed','restart_attested','probed','published')))) THEN RAISE EXCEPTION 'restore endpoint contract requires an explicit post-container operation backfill' USING ERRCODE = '23514'; END IF;
  IF EXISTS (
    SELECT 1 FROM public."agent_backup_restore_operations" operation
    WHERE operation."expected_endpoint_envelope" IS NOT NULL AND (NOT runtime_contract_installed OR EXISTS (SELECT 1 FROM public."agent_sandboxes" current_sandbox WHERE current_sandbox."id" = operation."agent_id" AND current_sandbox."organization_id" = operation."organization_id" AND current_sandbox."activation_generation" = operation."restore_attempt_id" AND current_sandbox."deleted_at" IS NULL AND current_sandbox."deletion_attempt_id" IS NULL AND current_sandbox."status" NOT IN ('deletion_pending','deletion_failed')) OR (operation."phase" NOT IN ('finalized','failed_terminal') AND NOT EXISTS (SELECT 1 FROM public."agent_sandboxes" fenced_sandbox WHERE fenced_sandbox."id" = operation."agent_id" AND fenced_sandbox."organization_id" = operation."organization_id" AND fenced_sandbox."activation_generation" = operation."restore_attempt_id" AND (fenced_sandbox."deleted_at" IS NOT NULL OR fenced_sandbox."deletion_attempt_id" IS NOT NULL OR fenced_sandbox."status" IN ('deletion_pending','deletion_failed'))))) AND NOT EXISTS (SELECT 1 FROM public."agent_sandboxes" sandbox WHERE sandbox."id" = operation."agent_id" AND sandbox."organization_id" = operation."organization_id" AND sandbox."activation_generation" = operation."restore_attempt_id" AND sandbox."deleted_at" IS NULL AND sandbox."deletion_attempt_id" IS NULL AND sandbox."status" NOT IN ('deletion_pending','deletion_failed') AND sandbox."activation_purpose" = 'restore' AND sandbox."activation_phase" IN ('restore_pending','restart_pending','restart_attested','active') AND sandbox."character_id"::text = operation."expected_endpoint_envelope"->>'runtimeAgentId' AND sandbox."activation_endpoint_envelope" = operation."expected_endpoint_envelope" AND sandbox."activation_endpoint_sha256" = operation."expected_endpoint_sha256" AND sandbox."activation_container_id" IS NOT DISTINCT FROM operation."expected_container_id" AND sandbox."activation_node_id" IS NOT DISTINCT FROM operation."expected_node_id" AND sandbox."activation_image_digest" IS NOT DISTINCT FROM operation."expected_image_digest" AND sandbox."activation_boot_id" IS NOT DISTINCT FROM operation."expected_node_incarnation")
    UNION ALL
    SELECT 1 FROM public."agent_activation_publications" publication
    WHERE publication."purpose" = 'restore' AND (NOT runtime_contract_installed OR EXISTS (SELECT 1 FROM public."agent_sandboxes" current_sandbox WHERE current_sandbox."id" = publication."agent_id" AND current_sandbox."organization_id" = publication."organization_id" AND current_sandbox."activation_generation" = publication."activation_generation" AND current_sandbox."deleted_at" IS NULL AND current_sandbox."deletion_attempt_id" IS NULL AND current_sandbox."status" NOT IN ('deletion_pending','deletion_failed'))) AND (NOT EXISTS (SELECT 1 FROM public."agent_sandboxes" sandbox WHERE sandbox."id" = publication."agent_id" AND sandbox."organization_id" = publication."organization_id" AND sandbox."activation_generation" = publication."activation_generation" AND sandbox."deleted_at" IS NULL AND sandbox."deletion_attempt_id" IS NULL AND sandbox."status" NOT IN ('deletion_pending','deletion_failed') AND sandbox."activation_purpose" = 'restore' AND sandbox."activation_phase" IN ('restart_attested','active') AND sandbox."character_id"::text = publication."endpoint_envelope"->>'runtimeAgentId' AND sandbox."activation_endpoint_envelope" = publication."endpoint_envelope" AND sandbox."activation_endpoint_sha256" = publication."endpoint_sha256" AND sandbox."activation_container_id" IS NOT DISTINCT FROM publication."container_id" AND sandbox."activation_node_id" IS NOT DISTINCT FROM publication."node_id" AND sandbox."activation_image_digest" IS NOT DISTINCT FROM publication."image_digest" AND sandbox."activation_boot_id" IS NOT DISTINCT FROM publication."node_incarnation") OR NOT EXISTS (SELECT 1 FROM public."agent_backup_restore_operations" operation WHERE operation."organization_id" = publication."organization_id" AND operation."agent_id" = publication."agent_id" AND operation."restore_attempt_id" = publication."activation_generation" AND operation."phase" IN ('probed','published','finalized') AND operation."expected_endpoint_envelope" = publication."endpoint_envelope" AND operation."expected_endpoint_sha256" = publication."endpoint_sha256" AND operation."expected_container_id" IS NOT DISTINCT FROM publication."container_id" AND operation."expected_node_id" IS NOT DISTINCT FROM publication."node_id" AND operation."expected_image_digest" IS NOT DISTINCT FROM publication."image_digest" AND operation."expected_node_incarnation" IS NOT DISTINCT FROM publication."node_incarnation"))
  ) THEN
    RAISE EXCEPTION 'restore endpoint contract requires an exact current runtime binding backfill'
      USING ERRCODE = '23514';
  END IF;
END;
$endpoint_preflight$;
--> statement-breakpoint
ALTER TABLE public."agent_backup_restore_operations" VALIDATE CONSTRAINT "agent_backup_restore_operations_endpoint_v1_check";
--> statement-breakpoint
ALTER TABLE public."agent_sandboxes" VALIDATE CONSTRAINT "agent_sandboxes_activation_endpoint_v1_check";
--> statement-breakpoint
ALTER TABLE public."agent_activation_publications" VALIDATE CONSTRAINT "agent_activation_publications_endpoint_v1_check";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public."guard_agent_sandbox_endpoint_identity_transition"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $endpoint$
BEGIN
  IF OLD."activation_endpoint_envelope" IS NOT NULL
    AND NEW."activation_generation" IS NOT DISTINCT FROM OLD."activation_generation"
    AND ROW(NEW."character_id", NEW."activation_endpoint_envelope", NEW."activation_endpoint_sha256")
      IS DISTINCT FROM ROW(OLD."character_id", OLD."activation_endpoint_envelope", OLD."activation_endpoint_sha256") THEN
    RAISE EXCEPTION 'bound sandbox endpoint authority is immutable within one activation generation: %', OLD."id" USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$endpoint$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_sandboxes_endpoint_identity_transition" ON public."agent_sandboxes";
--> statement-breakpoint
CREATE TRIGGER "agent_sandboxes_endpoint_identity_transition" BEFORE UPDATE OF "character_id", "activation_endpoint_envelope", "activation_endpoint_sha256" ON public."agent_sandboxes" FOR EACH ROW EXECUTE FUNCTION public."guard_agent_sandbox_endpoint_identity_transition"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public."enforce_agent_restore_endpoint_runtime_binding_v3"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $endpoint$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  old_data jsonb := CASE TG_OP WHEN 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  endpoint_envelope jsonb := CASE WHEN TG_TABLE_NAME = 'agent_backup_restore_operations' THEN row_data->'expected_endpoint_envelope' ELSE row_data->'endpoint_envelope' END;
  endpoint_sha256 text := CASE WHEN TG_TABLE_NAME = 'agent_backup_restore_operations' THEN row_data->>'expected_endpoint_sha256' ELSE row_data->>'endpoint_sha256' END;
  endpoint_generation uuid := (CASE WHEN TG_TABLE_NAME = 'agent_backup_restore_operations' THEN row_data->>'restore_attempt_id' ELSE row_data->>'activation_generation' END)::uuid;
BEGIN
  IF endpoint_sha256 IS NOT NULL AND TG_TABLE_NAME = 'agent_activation_publications' AND row_data->>'purpose' = 'restore' THEN
    PERFORM 1 FROM public."agent_backup_restore_operations" operation WHERE operation."organization_id" = (row_data->>'organization_id')::uuid AND operation."agent_id" = (row_data->>'agent_id')::uuid AND operation."restore_attempt_id" = endpoint_generation AND operation."phase" = 'probed' AND operation."expected_endpoint_envelope" = endpoint_envelope AND operation."expected_endpoint_sha256" = endpoint_sha256 AND operation."expected_container_id" IS NOT DISTINCT FROM row_data->>'container_id' AND operation."expected_node_id" IS NOT DISTINCT FROM row_data->>'node_id' AND operation."expected_image_digest" IS NOT DISTINCT FROM row_data->>'image_digest' AND operation."expected_node_incarnation"::text IS NOT DISTINCT FROM row_data->>'node_incarnation' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'restore publication endpoint authority is not bound to its durable operation: %', row_data->>'id' USING ERRCODE = '55000'; END IF;
  END IF;
  IF endpoint_sha256 IS NOT NULL AND (TG_TABLE_NAME <> 'agent_activation_publications' OR row_data->>'purpose' = 'restore') AND (TG_TABLE_NAME = 'agent_activation_publications' OR TG_OP = 'INSERT' OR endpoint_envelope IS DISTINCT FROM old_data->'expected_endpoint_envelope' OR endpoint_sha256 IS DISTINCT FROM old_data->>'expected_endpoint_sha256' OR row_data->>'phase' IN ('container_created','restoring','committed','restart_attested','probed','published','finalized')) THEN
    PERFORM 1 FROM public."agent_sandboxes" sandbox
    WHERE sandbox."id" = (row_data->>'agent_id')::uuid
      AND sandbox."organization_id" = (row_data->>'organization_id')::uuid
      AND sandbox."activation_generation" = endpoint_generation
      AND sandbox."deleted_at" IS NULL AND sandbox."deletion_attempt_id" IS NULL AND sandbox."status" NOT IN ('deletion_pending','deletion_failed')
      AND sandbox."activation_purpose" = 'restore'
      AND ((TG_TABLE_NAME = 'agent_backup_restore_operations' AND sandbox."activation_phase" IN ('restore_pending','restart_pending','restart_attested','active')) OR (TG_TABLE_NAME = 'agent_activation_publications' AND sandbox."activation_phase" IN ('restart_attested','active')))
      AND sandbox."character_id"::text = endpoint_envelope->>'runtimeAgentId'
      AND sandbox."activation_endpoint_envelope" = endpoint_envelope
      AND sandbox."activation_endpoint_sha256" = endpoint_sha256 AND sandbox."activation_container_id" IS NOT DISTINCT FROM CASE WHEN TG_TABLE_NAME = 'agent_backup_restore_operations' THEN row_data->>'expected_container_id' ELSE row_data->>'container_id' END AND sandbox."activation_node_id" IS NOT DISTINCT FROM CASE WHEN TG_TABLE_NAME = 'agent_backup_restore_operations' THEN row_data->>'expected_node_id' ELSE row_data->>'node_id' END AND sandbox."activation_image_digest" IS NOT DISTINCT FROM CASE WHEN TG_TABLE_NAME = 'agent_backup_restore_operations' THEN row_data->>'expected_image_digest' ELSE row_data->>'image_digest' END AND sandbox."activation_boot_id"::text IS NOT DISTINCT FROM CASE WHEN TG_TABLE_NAME = 'agent_backup_restore_operations' THEN row_data->>'expected_node_incarnation' ELSE row_data->>'node_incarnation' END
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'restore endpoint authority is not bound to the exact sandbox runtime: %', row_data->>'id' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$endpoint$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_operations_runtime_binding" ON public."agent_backup_restore_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_operations_runtime_binding" BEFORE INSERT OR UPDATE OF "phase", "resume_phase", "expected_endpoint_envelope", "expected_endpoint_sha256" ON public."agent_backup_restore_operations" FOR EACH ROW EXECUTE FUNCTION public."enforce_agent_restore_endpoint_runtime_binding_v3"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_activation_publications_endpoint_runtime_binding" ON public."agent_activation_publications";
--> statement-breakpoint
CREATE TRIGGER "agent_activation_publications_endpoint_runtime_binding" BEFORE INSERT ON public."agent_activation_publications" FOR EACH ROW EXECUTE FUNCTION public."enforce_agent_restore_endpoint_runtime_binding_v3"();
