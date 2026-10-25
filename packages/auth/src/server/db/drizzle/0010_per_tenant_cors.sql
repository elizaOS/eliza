-- Per-tenant CORS: adds allowed_origins column to tenant_configs
-- Safe to run on existing DB (ADD COLUMN IF NOT EXISTS)

ALTER TABLE tenant_configs
  ADD COLUMN IF NOT EXISTS allowed_origins TEXT[] NOT NULL DEFAULT '{}';
