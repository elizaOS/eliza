ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "serving_placement" jsonb;
