-- Expand endpoint authority without scanning existing rows under the ADD COLUMN lock.
ALTER TABLE public."agent_backup_restore_operations" ADD COLUMN IF NOT EXISTS "expected_endpoint_envelope" jsonb, ADD COLUMN IF NOT EXISTS "expected_endpoint_sha256" text;
--> statement-breakpoint
ALTER TABLE public."agent_sandboxes" ADD COLUMN IF NOT EXISTS "activation_endpoint_envelope" jsonb, ADD COLUMN IF NOT EXISTS "activation_endpoint_sha256" text;
--> statement-breakpoint
ALTER TABLE public."agent_activation_publications" ADD COLUMN IF NOT EXISTS "endpoint_envelope" jsonb, ADD COLUMN IF NOT EXISTS "endpoint_sha256" text;
--> statement-breakpoint
ALTER TABLE public."agent_backup_restore_operations" DROP CONSTRAINT IF EXISTS "agent_backup_restore_operations_endpoint_v1_check";
--> statement-breakpoint
ALTER TABLE public."agent_backup_restore_operations" ADD CONSTRAINT "agent_backup_restore_operations_endpoint_v1_check" CHECK (((
  ("expected_endpoint_envelope" IS NULL AND "expected_endpoint_sha256" IS NULL) OR
  ("expected_endpoint_envelope" IS NOT NULL AND "expected_endpoint_sha256" ~ '^[0-9a-f]{64}$' AND jsonb_typeof("expected_endpoint_envelope") = 'object'
    AND "expected_endpoint_envelope" ?& ARRAY['version','generation','kind','serverName','runtimeAgentId','registryUrl','bridgeUrl','healthUrl']::text[]
    AND ("expected_endpoint_envelope" - ARRAY['version','generation','kind','serverName','runtimeAgentId','registryUrl','bridgeUrl','healthUrl']::text[]) = '{}'::jsonb
    AND jsonb_typeof("expected_endpoint_envelope"->'version') = 'number' AND "expected_endpoint_envelope"->>'version' = '1'
    AND jsonb_typeof("expected_endpoint_envelope"->'generation') = 'string' AND "expected_endpoint_envelope"->>'generation' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND "expected_endpoint_envelope"->>'generation' = "restore_attempt_id"::text
    AND jsonb_typeof("expected_endpoint_envelope"->'kind') = 'string' AND "expected_endpoint_envelope"->>'kind' = 'dedicated-sandbox'
    AND jsonb_typeof("expected_endpoint_envelope"->'serverName') = 'string' AND "expected_endpoint_envelope"->>'serverName' = 'sandbox-' || "restore_attempt_id"::text
    AND jsonb_typeof("expected_endpoint_envelope"->'runtimeAgentId') = 'string' AND "expected_endpoint_envelope"->>'runtimeAgentId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ("expected_endpoint_envelope"->>'registryUrl') ~ '^https?://((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|(([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])\.)*[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/[^\\?#[:space:][:cntrl:]]*)?$' AND octet_length("expected_endpoint_envelope"->>'registryUrl') BETWEEN 1 AND 4096
    AND octet_length("expected_endpoint_envelope"->>'registryUrl') = length("expected_endpoint_envelope"->>'registryUrl')
    AND ("expected_endpoint_envelope"->>'bridgeUrl') ~ '^https?://((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|(([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])\.)*[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/[^\\?#[:space:][:cntrl:]]*)?$' AND octet_length("expected_endpoint_envelope"->>'bridgeUrl') BETWEEN 1 AND 4096
    AND octet_length("expected_endpoint_envelope"->>'bridgeUrl') = length("expected_endpoint_envelope"->>'bridgeUrl')
    AND ("expected_endpoint_envelope"->>'healthUrl') ~ '^https?://((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|(([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])\.)*[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/[^\\?#[:space:][:cntrl:]]*)?$' AND octet_length("expected_endpoint_envelope"->>'healthUrl') BETWEEN 1 AND 4096
    AND octet_length("expected_endpoint_envelope"->>'healthUrl') = length("expected_endpoint_envelope"->>'healthUrl')
    AND "expected_endpoint_sha256" = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('{"version":1,"generation":' || pg_catalog.to_json("expected_endpoint_envelope"->>'generation')::text || ',"kind":"dedicated-sandbox","serverName":' || pg_catalog.to_json("expected_endpoint_envelope"->>'serverName')::text || ',"runtimeAgentId":' || pg_catalog.to_json("expected_endpoint_envelope"->>'runtimeAgentId')::text || ',"registryUrl":' || pg_catalog.to_json("expected_endpoint_envelope"->>'registryUrl')::text || ',"bridgeUrl":' || pg_catalog.to_json("expected_endpoint_envelope"->>'bridgeUrl')::text || ',"healthUrl":' || pg_catalog.to_json("expected_endpoint_envelope"->>'healthUrl')::text || '}', 'UTF8')), 'hex')))
  AND (("phase" NOT IN ('container_created','restoring','committed','restart_attested','probed','published','finalized') AND ("phase" <> 'failed_retryable' OR "resume_phase" NOT IN ('container_created','restoring','committed','restart_attested','probed','published'))) OR "expected_endpoint_envelope" IS NOT NULL)) IS TRUE) NOT VALID;
--> statement-breakpoint
ALTER TABLE public."agent_sandboxes" DROP CONSTRAINT IF EXISTS "agent_sandboxes_activation_endpoint_v1_check";
--> statement-breakpoint
ALTER TABLE public."agent_sandboxes" ADD CONSTRAINT "agent_sandboxes_activation_endpoint_v1_check" CHECK (((
  ("activation_endpoint_envelope" IS NULL AND "activation_endpoint_sha256" IS NULL) OR
  ("activation_endpoint_envelope" IS NOT NULL AND "activation_endpoint_sha256" ~ '^[0-9a-f]{64}$' AND jsonb_typeof("activation_endpoint_envelope") = 'object'
    AND "activation_endpoint_envelope" ?& ARRAY['version','generation','kind','serverName','runtimeAgentId','registryUrl','bridgeUrl','healthUrl']::text[]
    AND ("activation_endpoint_envelope" - ARRAY['version','generation','kind','serverName','runtimeAgentId','registryUrl','bridgeUrl','healthUrl']::text[]) = '{}'::jsonb
    AND jsonb_typeof("activation_endpoint_envelope"->'version') = 'number' AND "activation_endpoint_envelope"->>'version' = '1'
    AND jsonb_typeof("activation_endpoint_envelope"->'generation') = 'string' AND "activation_endpoint_envelope"->>'generation' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND "activation_endpoint_envelope"->>'generation' = "activation_generation"::text
    AND jsonb_typeof("activation_endpoint_envelope"->'kind') = 'string' AND "activation_endpoint_envelope"->>'kind' = 'dedicated-sandbox'
    AND jsonb_typeof("activation_endpoint_envelope"->'serverName') = 'string' AND "activation_endpoint_envelope"->>'serverName' = 'sandbox-' || "activation_generation"::text
    AND jsonb_typeof("activation_endpoint_envelope"->'runtimeAgentId') = 'string' AND "activation_endpoint_envelope"->>'runtimeAgentId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND "character_id" IS NOT NULL AND "activation_endpoint_envelope"->>'runtimeAgentId' = "character_id"::text
    AND ("activation_endpoint_envelope"->>'registryUrl') ~ '^https?://((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|(([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])\.)*[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/[^\\?#[:space:][:cntrl:]]*)?$' AND octet_length("activation_endpoint_envelope"->>'registryUrl') BETWEEN 1 AND 4096
    AND octet_length("activation_endpoint_envelope"->>'registryUrl') = length("activation_endpoint_envelope"->>'registryUrl')
    AND ("activation_endpoint_envelope"->>'bridgeUrl') ~ '^https?://((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|(([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])\.)*[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/[^\\?#[:space:][:cntrl:]]*)?$' AND octet_length("activation_endpoint_envelope"->>'bridgeUrl') BETWEEN 1 AND 4096
    AND octet_length("activation_endpoint_envelope"->>'bridgeUrl') = length("activation_endpoint_envelope"->>'bridgeUrl')
    AND ("activation_endpoint_envelope"->>'healthUrl') ~ '^https?://((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|(([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])\.)*[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/[^\\?#[:space:][:cntrl:]]*)?$' AND octet_length("activation_endpoint_envelope"->>'healthUrl') BETWEEN 1 AND 4096
    AND octet_length("activation_endpoint_envelope"->>'healthUrl') = length("activation_endpoint_envelope"->>'healthUrl')
    AND "activation_endpoint_sha256" = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('{"version":1,"generation":' || pg_catalog.to_json("activation_endpoint_envelope"->>'generation')::text || ',"kind":"dedicated-sandbox","serverName":' || pg_catalog.to_json("activation_endpoint_envelope"->>'serverName')::text || ',"runtimeAgentId":' || pg_catalog.to_json("activation_endpoint_envelope"->>'runtimeAgentId')::text || ',"registryUrl":' || pg_catalog.to_json("activation_endpoint_envelope"->>'registryUrl')::text || ',"bridgeUrl":' || pg_catalog.to_json("activation_endpoint_envelope"->>'bridgeUrl')::text || ',"healthUrl":' || pg_catalog.to_json("activation_endpoint_envelope"->>'healthUrl')::text || '}', 'UTF8')), 'hex')))
  AND ("activation_purpose" IS DISTINCT FROM 'restore' OR "activation_phase" NOT IN ('restart_attested','active') OR "activation_endpoint_envelope" IS NOT NULL)) IS TRUE) NOT VALID;
--> statement-breakpoint
ALTER TABLE public."agent_activation_publications" DROP CONSTRAINT IF EXISTS "agent_activation_publications_endpoint_v1_check";
--> statement-breakpoint
ALTER TABLE public."agent_activation_publications" ADD CONSTRAINT "agent_activation_publications_endpoint_v1_check" CHECK (((
  "purpose" = 'restore' AND "endpoint_envelope" IS NOT NULL AND "endpoint_sha256" ~ '^[0-9a-f]{64}$' AND jsonb_typeof("endpoint_envelope") = 'object'
    AND "endpoint_envelope" ?& ARRAY['version','generation','kind','serverName','runtimeAgentId','registryUrl','bridgeUrl','healthUrl']::text[]
    AND ("endpoint_envelope" - ARRAY['version','generation','kind','serverName','runtimeAgentId','registryUrl','bridgeUrl','healthUrl']::text[]) = '{}'::jsonb
    AND jsonb_typeof("endpoint_envelope"->'version') = 'number' AND "endpoint_envelope"->>'version' = '1'
    AND jsonb_typeof("endpoint_envelope"->'generation') = 'string' AND "endpoint_envelope"->>'generation' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND "endpoint_envelope"->>'generation' = "activation_generation"::text
    AND jsonb_typeof("endpoint_envelope"->'kind') = 'string' AND "endpoint_envelope"->>'kind' = 'dedicated-sandbox'
    AND jsonb_typeof("endpoint_envelope"->'serverName') = 'string' AND "endpoint_envelope"->>'serverName' = 'sandbox-' || "activation_generation"::text
    AND jsonb_typeof("endpoint_envelope"->'runtimeAgentId') = 'string' AND "endpoint_envelope"->>'runtimeAgentId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND ("endpoint_envelope"->>'registryUrl') ~ '^https?://((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|(([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])\.)*[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/[^\\?#[:space:][:cntrl:]]*)?$' AND octet_length("endpoint_envelope"->>'registryUrl') BETWEEN 1 AND 4096
    AND octet_length("endpoint_envelope"->>'registryUrl') = length("endpoint_envelope"->>'registryUrl')
    AND ("endpoint_envelope"->>'bridgeUrl') ~ '^https?://((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|(([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])\.)*[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/[^\\?#[:space:][:cntrl:]]*)?$' AND octet_length("endpoint_envelope"->>'bridgeUrl') BETWEEN 1 AND 4096
    AND octet_length("endpoint_envelope"->>'bridgeUrl') = length("endpoint_envelope"->>'bridgeUrl')
    AND ("endpoint_envelope"->>'healthUrl') ~ '^https?://((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}|(([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]{0,61}[A-Za-z0-9])\.)*[A-Za-z]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?(/[^\\?#[:space:][:cntrl:]]*)?$' AND octet_length("endpoint_envelope"->>'healthUrl') BETWEEN 1 AND 4096
    AND octet_length("endpoint_envelope"->>'healthUrl') = length("endpoint_envelope"->>'healthUrl')
    AND "endpoint_sha256" = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to('{"version":1,"generation":' || pg_catalog.to_json("endpoint_envelope"->>'generation')::text || ',"kind":"dedicated-sandbox","serverName":' || pg_catalog.to_json("endpoint_envelope"->>'serverName')::text || ',"runtimeAgentId":' || pg_catalog.to_json("endpoint_envelope"->>'runtimeAgentId')::text || ',"registryUrl":' || pg_catalog.to_json("endpoint_envelope"->>'registryUrl')::text || ',"bridgeUrl":' || pg_catalog.to_json("endpoint_envelope"->>'bridgeUrl')::text || ',"healthUrl":' || pg_catalog.to_json("endpoint_envelope"->>'healthUrl')::text || '}', 'UTF8')), 'hex'))
  OR ("purpose" <> 'restore' AND "endpoint_envelope" IS NULL AND "endpoint_sha256" IS NULL)) IS TRUE) NOT VALID;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public."guard_agent_restore_endpoint_write_once"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $endpoint$
BEGIN
  IF OLD."expected_endpoint_envelope" IS NOT NULL AND ROW(NEW."expected_endpoint_envelope", NEW."expected_endpoint_sha256") IS DISTINCT FROM ROW(OLD."expected_endpoint_envelope", OLD."expected_endpoint_sha256") THEN
    RAISE EXCEPTION 'restore operation endpoint authority is write-once: %', OLD."id" USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$endpoint$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_backup_restore_operations_endpoint_write_once" ON public."agent_backup_restore_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_backup_restore_operations_endpoint_write_once" BEFORE UPDATE OF "expected_endpoint_envelope", "expected_endpoint_sha256" ON public."agent_backup_restore_operations" FOR EACH ROW EXECUTE FUNCTION public."guard_agent_restore_endpoint_write_once"();
