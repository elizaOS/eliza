ALTER TABLE "tenant_app_clients"
  ADD COLUMN IF NOT EXISTS "embedded_wallets" jsonb;
