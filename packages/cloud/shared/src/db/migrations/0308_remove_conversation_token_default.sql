-- Remove the hidden model-output cap for new conversations while preserving all
-- other deployed defaults.
ALTER TABLE "conversations" ALTER COLUMN "settings" SET DEFAULT '{"temperature":0.7,"topP":1,"frequencyPenalty":0,"presencePenalty":0,"systemPrompt":"You are a helpful AI assistant."}'::jsonb;
--> statement-breakpoint
-- The exact object below is the sole historical database default. Restricting
-- the backfill to full-object equality leaves every customized settings object,
-- including an explicitly selected 2000-token value, unchanged.
UPDATE "conversations"
SET "settings" = "settings" - 'maxTokens'
WHERE "settings" = '{"temperature":0.7,"maxTokens":2000,"topP":1,"frequencyPenalty":0,"presencePenalty":0,"systemPrompt":"You are a helpful AI assistant."}'::jsonb;
