ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_resource_manifest" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  DROP CONSTRAINT IF EXISTS "agent_sandboxes_replacement_resource_manifest_check";
--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  ADD CONSTRAINT "agent_sandboxes_replacement_resource_manifest_check" CHECK ((
    replacement_cleanup_resource_manifest IS NULL OR (
      replacement_cleanup_sandbox_id IS NOT NULL
      AND replacement_cleanup_attempt_id IS NULL
      AND replacement_cleanup_resource_manifest->>'version' = '1'
        AND replacement_cleanup_resource_manifest->>'agentId' = id::text
        AND replacement_cleanup_resource_manifest->>'organizationId' = organization_id::text
        AND replacement_cleanup_resource_manifest->'deletionPolicy'->>'kind' = 'recovery_required'
        AND (replacement_cleanup_resource_manifest->>'deletionAttemptId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND jsonb_typeof(replacement_cleanup_resource_manifest->'resources') = 'object'
      AND replacement_cleanup_resource_manifest->'servingPlacement'->'locator'->>'sandboxId' = replacement_cleanup_sandbox_id
      AND replacement_cleanup_resource_manifest->'servingPlacement'->'locator'->>'nodeId' = replacement_cleanup_node_id
      AND replacement_cleanup_resource_manifest->'servingPlacement'->'locator'->>'containerName' = replacement_cleanup_container_name
    )
  ) IS TRUE);
