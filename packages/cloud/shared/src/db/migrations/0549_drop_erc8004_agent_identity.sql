-- Remove ERC-8004 agent identity storage. The feature is removed, so the
-- agent_identities table and the unused erc8004_* registration columns on
-- user_characters and user_mcps are dropped. Dropping a column also drops
-- the indexes that use it.
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
