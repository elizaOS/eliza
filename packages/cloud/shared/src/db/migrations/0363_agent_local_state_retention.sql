ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "local_state_retention" jsonb;
