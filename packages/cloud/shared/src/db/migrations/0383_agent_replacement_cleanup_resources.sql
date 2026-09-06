-- Candidate cleanup retains the same resource-manifest contract as serving retirement.
ALTER TABLE "agent_sandbox_replacement_attempts"
  ADD COLUMN IF NOT EXISTS "cleanup_resource_manifest" jsonb;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_replacement_cleanup_resources"()
RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE resource text;
BEGIN
  IF NEW.cleanup_resource_manifest IS NOT NULL THEN
    IF (NEW.restore_attempt_id IS NULL
      AND NEW.state IN ('cleanup_in_progress', 'cleanup_proven')
      AND NEW.provider_succeeded_at IS NOT NULL
      AND NEW.locator_container_id ~ '^[0-9a-f]{64}$'
      AND NEW.cleanup_resource_manifest @> jsonb_build_object(
        'version', 1, 'deletionAttemptId', NEW.id::text,
        'agentId', NEW.agent_id::text, 'organizationId', NEW.organization_id::text,
        'deletionPolicy', jsonb_build_object('kind', 'recovery_required'),
        'localStateRetention', NULL,
        'servingPlacement', jsonb_build_object('version', 1,
          'volumePath', '/data/agents/' || NEW.agent_id::text,
          'locator', jsonb_build_object(
            'replacementAttemptId', NEW.id::text, 'sandboxId', NEW.locator_sandbox_id,
            'nodeId', NEW.locator_node_id, 'containerName', NEW.locator_container_name,
            'containerId', NEW.locator_container_id, 'nodeRecordId', NEW.locator_node_record_id::text,
            'nodeIncarnation', NEW.locator_node_incarnation::text, 'nodeHistoryId', NEW.locator_node_history_id::text,
            'nodeHostname', NEW.locator_node_hostname, 'nodeSshPort', NEW.locator_node_ssh_port,
            'nodeSshUser', NEW.locator_node_ssh_user, 'nodeHostKeyFingerprint', NEW.locator_node_host_key_fingerprint,
            'replacementSecretCleanupVersion', 1, 'allocationCounted', true,
            'vpnNodeName', NEW.locator_vpn_node_name, 'vpnNodeId', NEW.locator_vpn_node_id,
            'previousVpnNodeId', NEW.locator_previous_vpn_node_id, 'vpnAuthority', NEW.locator_vpn_authority)))
      AND (NEW.cleanup_resource_manifest #>> '{servingPlacement,locator,vpnRegistrationStartedAt}')::timestamptz
        IS NOT DISTINCT FROM NEW.locator_vpn_registration_started_at
      AND jsonb_typeof(NEW.cleanup_resource_manifest->'resources') = 'object'
      AND NEW.cleanup_resource_manifest #>> '{resources,volume,state}' IN ('unknown', 'captured', 'absent')
      AND NEW.cleanup_resource_manifest #>> '{resources,vpn,state}' IN ('unknown', 'absent')
      AND NEW.cleanup_resource_manifest #>> '{resources,secrets,state}' IN ('unknown', 'absent')) IS NOT TRUE THEN
      RAISE EXCEPTION 'replacement cleanup manifest differs from its candidate authority';
    END IF;
    IF (TG_OP = 'INSERT' OR OLD.cleanup_resource_manifest IS NULL)
      AND NEW.cleanup_resource_manifest->'resources' IS DISTINCT FROM
        '{"volume":{"state":"unknown"},"vpn":{"state":"unknown"},"secrets":{"state":"unknown"}}'::jsonb THEN
      RAISE EXCEPTION 'replacement cleanup must begin with unobserved resources';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.cleanup_resource_manifest IS NOT NULL THEN
    IF NEW.cleanup_resource_manifest IS NULL OR
      (OLD.cleanup_resource_manifest - 'resources') IS DISTINCT FROM (NEW.cleanup_resource_manifest - 'resources') THEN
      RAISE EXCEPTION 'replacement cleanup manifest identity is immutable';
    END IF;
    IF OLD.cleanup_resource_manifest #>> '{resources,volume,state}' = 'unknown'
      AND NEW.cleanup_resource_manifest #>> '{resources,volume,state}' = 'absent' THEN
      RAISE EXCEPTION 'replacement volume absence requires a captured filesystem identity';
    END IF;
    FOREACH resource IN ARRAY ARRAY['volume', 'vpn', 'secrets'] LOOP
      IF OLD.cleanup_resource_manifest #>> ARRAY['resources', resource, 'state'] <> 'unknown'
        AND OLD.cleanup_resource_manifest #> ARRAY['resources', resource]
          IS DISTINCT FROM NEW.cleanup_resource_manifest #> ARRAY['resources', resource]
        AND (resource = 'volume'
          AND OLD.cleanup_resource_manifest #>> '{resources,volume,state}' = 'captured'
          AND NEW.cleanup_resource_manifest #>> '{resources,volume,state}' = 'absent'
          AND NEW.cleanup_resource_manifest #> '{resources,volume,capture}' = OLD.cleanup_resource_manifest #> '{resources,volume}') IS NOT TRUE THEN
        RAISE EXCEPTION 'replacement cleanup observation cannot be reset or replaced';
      END IF;
    END LOOP;
  END IF;
  IF NEW.state = 'cleanup_proven' AND NEW.cleanup_resource_manifest IS NOT NULL
    AND (NEW.cleanup_resource_manifest->'resources' @> '{"volume":{"state":"absent"},"vpn":{"state":"absent"},"secrets":{"state":"absent"}}'::jsonb) IS NOT TRUE THEN
    RAISE EXCEPTION 'replacement cleanup cannot release retained resources';
  END IF;
  RETURN NEW;
END;
$guard$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_replacement_cleanup_resources_guard" ON "agent_sandbox_replacement_attempts";
--> statement-breakpoint
CREATE TRIGGER "agent_replacement_cleanup_resources_guard"
BEFORE INSERT OR UPDATE ON "agent_sandbox_replacement_attempts"
FOR EACH ROW EXECUTE FUNCTION "guard_agent_replacement_cleanup_resources"();
