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
