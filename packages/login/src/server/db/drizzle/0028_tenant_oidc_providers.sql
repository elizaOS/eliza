ALTER TABLE "tenant_configs" ADD COLUMN IF NOT EXISTS "oidc_providers" jsonb NOT NULL DEFAULT '[]'::jsonb;
