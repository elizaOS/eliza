-- Add Discord automation field to apps table
ALTER TABLE "apps"
ADD COLUMN IF NOT EXISTS "discord_automation" jsonb
DEFAULT '{"enabled": false, "autoAnnounce": false, "announceIntervalMin": 120, "announceIntervalMax": 240}';
