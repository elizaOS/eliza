ALTER TABLE "agent_server_wallets"
  DROP CONSTRAINT IF EXISTS "agent_server_wallets_client_address_unique";

CREATE UNIQUE INDEX IF NOT EXISTS "agent_server_wallets_org_client_chain_unique"
  ON "agent_server_wallets" ("organization_id", "client_address", "chain_type");
