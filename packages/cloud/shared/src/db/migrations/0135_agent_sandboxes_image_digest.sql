ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "image_digest" text;
