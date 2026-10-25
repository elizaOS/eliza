ALTER TABLE "agent_server_wallets"
  DROP CONSTRAINT IF EXISTS "agent_server_wallets_client_address_unique";

DROP INDEX IF EXISTS "agent_server_wallets_org_client_chain_unique";

UPDATE "agent_server_wallets"
  SET "client_address" = lower("client_address");

CREATE UNIQUE INDEX IF NOT EXISTS "agent_server_wallets_client_address_chain_unique"
  ON "agent_server_wallets" ("client_address", "chain_type");
