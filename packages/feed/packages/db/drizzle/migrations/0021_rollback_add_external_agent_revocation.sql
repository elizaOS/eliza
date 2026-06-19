-- Rollback: Remove external agent API key revocation + ownership tracking

ALTER TABLE "ExternalAgentConnection" DROP COLUMN IF EXISTS "revokedBy";
ALTER TABLE "ExternalAgentConnection" DROP COLUMN IF EXISTS "revokedAt";
ALTER TABLE "ExternalAgentConnection" DROP COLUMN IF EXISTS "registeredByUserId";

