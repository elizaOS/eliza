-- Add twitter_automation column to apps table for vibe marketing automation
ALTER TABLE "apps" ADD COLUMN "twitter_automation" jsonb DEFAULT '{"enabled":false,"autoPost":false,"autoReply":false,"autoEngage":false,"discovery":false,"postIntervalMin":90,"postIntervalMax":150}'::jsonb;

-- Add index for querying apps with active twitter automation
CREATE INDEX "apps_twitter_automation_enabled_idx" ON "apps" ((twitter_automation->>'enabled')) WHERE (twitter_automation->>'enabled')::boolean = true;
