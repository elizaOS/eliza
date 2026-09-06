-- Per-tenant email config: adds email_config column to tenant_configs
-- Safe to run on existing DB (ADD COLUMN IF NOT EXISTS)

ALTER TABLE tenant_configs
  ADD COLUMN IF NOT EXISTS email_config JSONB;
