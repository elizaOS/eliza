-- Tenant control plane configuration table
-- Stores per-tenant UI/policy configuration, separate from the auth-critical tenants table

CREATE TABLE IF NOT EXISTS "tenant_configs" (
  "tenant_id" varchar(64) PRIMARY KEY REFERENCES "tenants"("id") ON DELETE CASCADE,
  "display_name" varchar(255),
  "policy_exposure" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "policy_templates" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "secret_route_presets" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "approval_config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "feature_flags" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "theme" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

-- Indexes on transactions for efficient filtering (dashboard/history queries)
CREATE INDEX IF NOT EXISTS "transactions_status_idx" ON "transactions"("status");
CREATE INDEX IF NOT EXISTS "transactions_chain_id_idx" ON "transactions"("chain_id");
CREATE INDEX IF NOT EXISTS "transactions_created_at_idx" ON "transactions"("created_at" DESC);
