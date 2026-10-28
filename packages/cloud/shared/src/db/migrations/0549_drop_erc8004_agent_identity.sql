-- Remove ERC-8004 agent identity storage. The feature is removed, so the
-- agent_identities table and the unused erc8004_* registration columns on
-- user_characters and user_mcps are dropped. Dropping a column also drops
-- the indexes that use it. The embedded "steward" schema (0096) also holds
-- dead ERC-8004 copies from the auth schema: agent_registrations,
-- reputation_cache, registry_index, and agents.erc8004_token_id. No code
-- reads them and the auth migrator never runs on this schema, so they are
-- dropped here too.
DROP TABLE "agent_identities";
--> statement-breakpoint
ALTER TABLE "user_characters"
  DROP COLUMN "erc8004_registered",
  DROP COLUMN "erc8004_network",
  DROP COLUMN "erc8004_agent_id",
  DROP COLUMN "erc8004_agent_uri",
  DROP COLUMN "erc8004_tx_hash",
  DROP COLUMN "erc8004_registered_at";
--> statement-breakpoint
ALTER TABLE "user_mcps"
  DROP COLUMN "erc8004_registered",
  DROP COLUMN "erc8004_network",
  DROP COLUMN "erc8004_agent_id",
  DROP COLUMN "erc8004_agent_uri",
  DROP COLUMN "erc8004_tx_hash",
  DROP COLUMN "erc8004_registered_at";
--> statement-breakpoint
DROP TABLE "steward"."agent_registrations";
--> statement-breakpoint
DROP TABLE "steward"."reputation_cache";
--> statement-breakpoint
DROP TABLE "steward"."registry_index";
--> statement-breakpoint
ALTER TABLE "steward"."agents" DROP COLUMN "erc8004_token_id";
