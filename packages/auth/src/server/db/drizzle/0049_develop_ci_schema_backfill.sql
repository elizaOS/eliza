-- Backfill schema changes that were originally numbered 0067-0072.
-- The API container's Drizzle migrator applied through 0048 in CI while the
-- runtime schema already referenced these newer columns/tables. This file is
-- intentionally idempotent so databases that already applied 0067-0072 are safe.

CREATE TABLE IF NOT EXISTS "digital_asset_accounts" (
  "id" varchar(64) PRIMARY KEY NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "display_name" varchar(255),
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "digital_asset_accounts_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digital_asset_accounts_tenant_idx"
  ON "digital_asset_accounts" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "digital_asset_accounts_tenant_id_idx"
  ON "digital_asset_accounts" ("tenant_id", "id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "digital_asset_account_wallets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "account_id" varchar(64) NOT NULL,
  "wallet_agent_id" varchar(64) NOT NULL,
  "chain_family" "chain_family",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "digital_asset_account_wallets_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade,
  CONSTRAINT "digital_asset_account_wallets_account_id_digital_asset_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "digital_asset_accounts"("id") ON DELETE cascade,
  CONSTRAINT "digital_asset_account_wallets_wallet_agent_id_agents_id_fk"
    FOREIGN KEY ("wallet_agent_id") REFERENCES "agents"("id") ON DELETE cascade,
  CONSTRAINT "digital_asset_account_wallets_tenant_account_fk"
    FOREIGN KEY ("tenant_id", "account_id")
    REFERENCES "digital_asset_accounts"("tenant_id", "id") ON DELETE cascade,
  CONSTRAINT "digital_asset_account_wallets_tenant_wallet_fk"
    FOREIGN KEY ("tenant_id", "wallet_agent_id")
    REFERENCES "agents"("tenant_id", "id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digital_asset_account_wallets_tenant_account_idx"
  ON "digital_asset_account_wallets" ("tenant_id", "account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digital_asset_account_wallets_wallet_idx"
  ON "digital_asset_account_wallets" ("wallet_agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "digital_asset_account_wallets_account_wallet_all_idx"
  ON "digital_asset_account_wallets" ("account_id", "wallet_agent_id")
  WHERE "chain_family" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "digital_asset_account_wallets_account_wallet_chain_idx"
  ON "digital_asset_account_wallets" ("account_id", "wallet_agent_id", "chain_family")
  WHERE "chain_family" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "digital_asset_account_wallets_tenant_wallet_all_idx"
  ON "digital_asset_account_wallets" ("tenant_id", "wallet_agent_id")
  WHERE "chain_family" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "digital_asset_account_wallets_tenant_wallet_chain_idx"
  ON "digital_asset_account_wallets" ("tenant_id", "wallet_agent_id", "chain_family")
  WHERE "chain_family" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "digital_asset_account_aggregations" (
  "id" varchar(64) PRIMARY KEY NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "account_id" varchar(64) NOT NULL,
  "display_name" varchar(255),
  "wallet_agent_ids" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "chain_families" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "digital_asset_account_aggregations_tenant_id_tenants_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade,
  CONSTRAINT "digital_asset_account_aggregations_account_id_digital_asset_accounts_id_fk"
    FOREIGN KEY ("account_id") REFERENCES "digital_asset_accounts"("id") ON DELETE cascade,
  CONSTRAINT "digital_asset_account_aggregations_tenant_account_fk"
    FOREIGN KEY ("tenant_id", "account_id")
    REFERENCES "digital_asset_accounts"("tenant_id", "id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "digital_asset_account_aggregations_tenant_account_idx"
  ON "digital_asset_account_aggregations" ("tenant_id", "account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "digital_asset_account_aggregations_tenant_id_idx"
  ON "digital_asset_account_aggregations" ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "tenant_app_clients"
  ADD COLUMN IF NOT EXISTS "embedded_wallets" jsonb;
--> statement-breakpoint
ALTER TABLE "agent_signers"
  ADD COLUMN IF NOT EXISTS "policy_ids" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TYPE "chain_family" ADD VALUE IF NOT EXISTS 'bitcoin';
--> statement-breakpoint
ALTER TABLE "agent_wallets"
  ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenant_app_clients"
  ADD COLUMN IF NOT EXISTS "allowed_bundle_ids" text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS "allowed_package_names" text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "vault_signing_freezes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE cascade,
  "scope_type" varchar(16) NOT NULL,
  "agent_id" varchar(64) REFERENCES "agents"("id") ON DELETE cascade,
  "wallet_id" uuid REFERENCES "agent_wallets"("id") ON DELETE cascade,
  "reason" text,
  "created_by_type" varchar(32) NOT NULL DEFAULT 'system',
  "created_by_id" varchar(128),
  "lifted_at" timestamp with time zone,
  "lifted_by_type" varchar(32),
  "lifted_by_id" varchar(128),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vault_signing_freezes_scope_chk"
    CHECK (
      ("scope_type" = 'tenant' AND "agent_id" IS NULL AND "wallet_id" IS NULL)
      OR ("scope_type" = 'agent' AND "agent_id" IS NOT NULL AND "wallet_id" IS NULL)
      OR ("scope_type" = 'wallet' AND "wallet_id" IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vault_signing_freezes_tenant_active_idx"
  ON "vault_signing_freezes" ("tenant_id", "scope_type")
  WHERE "scope_type" = 'tenant' AND "lifted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vault_signing_freezes_agent_active_idx"
  ON "vault_signing_freezes" ("tenant_id", "agent_id")
  WHERE "scope_type" = 'agent' AND "lifted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vault_signing_freezes_wallet_active_idx"
  ON "vault_signing_freezes" ("wallet_id")
  WHERE "scope_type" = 'wallet' AND "lifted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_signing_freezes_tenant_scope_idx"
  ON "vault_signing_freezes" ("tenant_id", "scope_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_signing_freezes_agent_idx"
  ON "vault_signing_freezes" ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vault_signing_freezes_wallet_idx"
  ON "vault_signing_freezes" ("wallet_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "evm_wallet_nonces" (
  "wallet_address" varchar(42) NOT NULL,
  "chain_id" integer NOT NULL,
  "next_nonce" bigint NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "evm_wallet_nonces_wallet_chain_idx"
  ON "evm_wallet_nonces" ("wallet_address", "chain_id");
