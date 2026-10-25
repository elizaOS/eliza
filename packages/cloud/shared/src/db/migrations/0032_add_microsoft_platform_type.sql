-- Add Microsoft platform type for OAuth support
-- Enables Microsoft/Outlook/Calendar integration

ALTER TYPE "platform_credential_type" ADD VALUE IF NOT EXISTS 'microsoft';
