-- Migration: Add external agent API key revocation + ownership tracking

ALTER TABLE "ExternalAgentConnection" ADD COLUMN IF NOT EXISTS "registeredByUserId" text;
ALTER TABLE "ExternalAgentConnection" ADD COLUMN IF NOT EXISTS "revokedAt" timestamp;
ALTER TABLE "ExternalAgentConnection" ADD COLUMN IF NOT EXISTS "revokedBy" text;

