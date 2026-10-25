ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "data_storage" text DEFAULT 'inline' NOT NULL;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "data_key" text;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "agent_id" text;
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "character_id" text;

UPDATE "jobs"
SET
  "agent_id" = COALESCE("agent_id", "data"->>'agentId'),
  "character_id" = COALESCE("character_id", "data"->>'characterId')
WHERE ("agent_id" IS NULL AND "data" ? 'agentId')
   OR ("character_id" IS NULL AND "data" ? 'characterId');

CREATE INDEX IF NOT EXISTS "jobs_org_type_agent_created_idx"
  ON "jobs" USING btree ("organization_id", "type", "agent_id", "created_at")
  WHERE "agent_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "jobs_org_type_character_created_idx"
  ON "jobs" USING btree ("organization_id", "type", "character_id", "created_at")
  WHERE "character_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "jobs_active_provision_agent_idx"
  ON "jobs" USING btree ("organization_id", "agent_id", "status")
  WHERE "type" = 'agent_provision' AND "agent_id" IS NOT NULL;
