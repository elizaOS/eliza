ALTER TABLE "tenant_configs"
ADD COLUMN IF NOT EXISTS "gas_sponsorship_config" jsonb DEFAULT '{}'::jsonb NOT NULL;
