-- Remove ERC-8004 agent registration storage. The feature is removed, so the
-- registration, reputation cache, and registry index tables and the unused
-- agents.erc8004_token_id column are dropped.
DROP TABLE "agent_registrations";
--> statement-breakpoint
DROP TABLE "reputation_cache";
--> statement-breakpoint
DROP TABLE "registry_index";
--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "erc8004_token_id";
