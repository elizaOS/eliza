-- Add price alerts JSON config to UserAgentConfig
-- Used by agents to persist and check threshold-based notifications

ALTER TABLE "UserAgentConfig"
ADD COLUMN IF NOT EXISTS "priceAlerts" json DEFAULT '[]'::json;
