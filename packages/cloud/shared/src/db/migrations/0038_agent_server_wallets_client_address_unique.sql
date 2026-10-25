-- Prevent concurrent provision races from creating duplicate rows for the same client_address
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.agent_server_wallets'::regclass
      AND conname = 'agent_server_wallets_client_address_unique'
  ) THEN
    ALTER TABLE agent_server_wallets
    ADD CONSTRAINT agent_server_wallets_client_address_unique UNIQUE (client_address);
  END IF;
END $$;
