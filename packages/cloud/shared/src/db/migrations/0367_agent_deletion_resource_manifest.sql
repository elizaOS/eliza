ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "deletion_resource_manifest" jsonb;
