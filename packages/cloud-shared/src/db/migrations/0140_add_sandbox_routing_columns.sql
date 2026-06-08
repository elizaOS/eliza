ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "short_id" text UNIQUE,
  ADD COLUMN IF NOT EXISTS "public_host" text,
  ADD COLUMN IF NOT EXISTS "public_url" text;

CREATE INDEX IF NOT EXISTS "agent_sandboxes_short_id_idx" ON "agent_sandboxes" ("short_id");
