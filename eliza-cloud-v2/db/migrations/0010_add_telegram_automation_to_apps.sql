-- Add telegram_automation JSONB column to apps table
ALTER TABLE "apps" ADD COLUMN "telegram_automation" jsonb DEFAULT '{"enabled":false,"autoReply":true,"autoAnnounce":false,"announceIntervalMin":120,"announceIntervalMax":240}' NOT NULL;
