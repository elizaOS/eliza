-- Service billing framework (service_pricing, audit) and entity settings table
-- Also adds missing indexes and constraints accumulated since migration 0038

-- Service pricing
CREATE TABLE IF NOT EXISTS "service_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" text NOT NULL,
	"method" text NOT NULL,
	"cost" numeric(12, 6) NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_pricing_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_pricing_id" uuid,
	"service_id" text NOT NULL,
	"method" text NOT NULL,
	"old_cost" numeric(12, 6),
	"new_cost" numeric(12, 6) NOT NULL,
	"change_type" text NOT NULL,
	"changed_by" text NOT NULL,
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_pricing_audit_service_pricing_id_service_pricing_id_fk') THEN
    ALTER TABLE "service_pricing_audit" ADD CONSTRAINT "service_pricing_audit_service_pricing_id_service_pricing_id_fk" FOREIGN KEY ("service_pricing_id") REFERENCES "public"."service_pricing"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_pricing_service_method_idx" ON "service_pricing" USING btree ("service_id","method");--> statement-breakpoint

-- Entity settings (per-user runtime settings with encryption)
CREATE TABLE IF NOT EXISTS "entity_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid,
	"key" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"encryption_key_id" text NOT NULL,
	"encrypted_dek" text NOT NULL,
	"nonce" text NOT NULL,
	"auth_tag" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_settings_user_id_users_id_fk') THEN
    ALTER TABLE "entity_settings" ADD CONSTRAINT "entity_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "entity_settings_user_agent_key_idx" ON "entity_settings" USING btree ("user_id","agent_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_settings_user_idx" ON "entity_settings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_settings_user_agent_idx" ON "entity_settings" USING btree ("user_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_settings_key_idx" ON "entity_settings" USING btree ("key");--> statement-breakpoint

-- New FK on existing table
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_sandbox_sessions_app_id_apps_id_fk') THEN
    ALTER TABLE "app_sandbox_sessions" ADD CONSTRAINT "app_sandbox_sessions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- New indexes on existing tables
CREATE INDEX IF NOT EXISTS "agent_budgets_paused_idx" ON "agent_budgets" USING btree ("is_paused");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_templates_is_featured_idx" ON "app_templates" USING btree ("is_featured");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "apps_user_database_status_idx" ON "apps" USING btree ("user_database_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "containers_billing_status_idx" ON "containers" USING btree ("billing_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "containers_next_billing_idx" ON "containers" USING btree ("next_billing_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "containers_scheduled_shutdown_idx" ON "containers" USING btree ("scheduled_shutdown_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "generations_org_status_user_created_idx" ON "generations" USING btree ("organization_id","status","user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_characters_username_idx" ON "user_characters" USING btree ("username");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_discord_id_idx" ON "users" USING btree ("discord_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_phone_number_idx" ON "users" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_telegram_id_idx" ON "users" USING btree ("telegram_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "alb_priorities_user_project_idx" ON "alb_priorities" USING btree ("user_id","project_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "platform_credentials_user_platform_idx" ON "platform_credentials" USING btree ("organization_id","user_id","platform") WHERE "platform_credentials"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seo_requests_idempotency_idx" ON "seo_requests" USING btree ("organization_id","idempotency_key");--> statement-breakpoint

-- Seed Solana RPC pricing
-- Tier 1 (default): 1 credit = $0.000006, Tier 2: 10 credits = $0.000060, Tier 3: 100 credits = $0.000600
INSERT INTO "service_pricing" ("id", "service_id", "method", "cost", "description", "metadata", "is_active", "updated_by", "created_at", "updated_at") VALUES
  (gen_random_uuid(), 'solana-rpc', '_default', '0.000006', 'Standard Solana RPC call', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  -- Tier 1 methods (1 credit = $0.000006)
  (gen_random_uuid(), 'solana-rpc', 'getBalance', '0.000006', 'Tier 1 - Get balance', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getAccountInfo', '0.000006', 'Tier 1 - Get account info', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getHealth', '0.000006', 'Tier 1 - Get health', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getSlot', '0.000006', 'Tier 1 - Get slot', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getBlockHeight', '0.000006', 'Tier 1 - Get block height', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getSlotLeader', '0.000006', 'Tier 1 - Get slot leader', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getSupply', '0.000006', 'Tier 1 - Get supply', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getTokenAccountBalance', '0.000006', 'Tier 1 - Get token account balance', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getTokenAccountsByDelegate', '0.000006', 'Tier 1 - Get token accounts by delegate', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getTokenAccountsByOwner', '0.000006', 'Tier 1 - Get token accounts by owner', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getTokenLargestAccounts', '0.000006', 'Tier 1 - Get token largest accounts', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getTokenSupply', '0.000006', 'Tier 1 - Get token supply', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getTransactionCount', '0.000006', 'Tier 1 - Get transaction count', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getVersion', '0.000006', 'Tier 1 - Get version', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getVoteAccounts', '0.000006', 'Tier 1 - Get vote accounts', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'sendTransaction', '0.000006', 'Tier 1 - Send transaction', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'simulateTransaction', '0.000006', 'Tier 1 - Simulate transaction', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'requestAirdrop', '0.000006', 'Tier 1 - Request airdrop', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getRecentBlockhash', '0.000006', 'Tier 1 - Get recent blockhash (deprecated)', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getEpochInfo', '0.000006', 'Tier 1 - Get epoch info', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getEpochSchedule', '0.000006', 'Tier 1 - Get epoch schedule', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getFeeForMessage', '0.000006', 'Tier 1 - Get fee for message', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getGenesisHash', '0.000006', 'Tier 1 - Get genesis hash', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getIdentity', '0.000006', 'Tier 1 - Get identity', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getLatestBlockhash', '0.000006', 'Tier 1 - Get latest blockhash', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getMinimumBalanceForRentExemption', '0.000006', 'Tier 1 - Get min balance for rent exemption', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getMultipleAccounts', '0.000006', 'Tier 1 - Get multiple accounts', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getRecentPrioritizationFees', '0.000006', 'Tier 1 - Get recent prioritization fees', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getSignatureStatuses', '0.000006', 'Tier 1 - Get signature statuses', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getStakeActivation', '0.000006', 'Tier 1 - Get stake activation', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getStakeMinimumDelegation', '0.000006', 'Tier 1 - Get stake minimum delegation', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'isBlockhashValid', '0.000006', 'Tier 1 - Is blockhash valid', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'minimumLedgerSlot', '0.000006', 'Tier 1 - Minimum ledger slot', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getFirstAvailableBlock', '0.000006', 'Tier 1 - Get first available block', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getHighestSnapshotSlot', '0.000006', 'Tier 1 - Get highest snapshot slot', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getInflationGovernor', '0.000006', 'Tier 1 - Get inflation governor', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getInflationRate', '0.000006', 'Tier 1 - Get inflation rate', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getLargestAccounts', '0.000006', 'Tier 1 - Get largest accounts', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getLeaderSchedule', '0.000006', 'Tier 1 - Get leader schedule', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getMaxRetransmitSlot', '0.000006', 'Tier 1 - Get max retransmit slot', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getMaxShredInsertSlot', '0.000006', 'Tier 1 - Get max shred insert slot', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getSlotLeaders', '0.000006', 'Tier 1 - Get slot leaders', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getRecentPerformanceSamples', '0.000006', 'Tier 1 - Get recent performance samples', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getBlockProduction', '0.000006', 'Tier 1 - Get block production', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getClusterNodes', '0.000006', 'Tier 1 - Get cluster nodes', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getConfirmedBlock', '0.000006', 'Tier 1 - Get confirmed block', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getConfirmedTransaction', '0.000006', 'Tier 1 - Get confirmed transaction', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getBlockCommitment', '0.000006', 'Tier 1 - Get block commitment', '{"provider_credits": 1, "tier": 1}'::jsonb, true, 'system', NOW(), NOW()),
  -- Tier 2 methods (10 credits = $0.000060)
  (gen_random_uuid(), 'solana-rpc', 'getAsset', '0.000060', 'DAS API - Get asset', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getAssetsByOwner', '0.000060', 'DAS API - Get assets by owner', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'searchAssets', '0.000060', 'DAS API - Search assets', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getTokenAccounts', '0.000060', 'DAS API - Get token accounts', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getAssetProof', '0.000060', 'DAS API - Get asset proof', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getAssetProofBatch', '0.000060', 'DAS API - Get asset proof batch', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getAssetsByAuthority', '0.000060', 'DAS API - Get assets by authority', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getAssetsByCreator', '0.000060', 'DAS API - Get assets by creator', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getAssetsByGroup', '0.000060', 'DAS API - Get assets by group', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getAssetBatch', '0.000060', 'DAS API - Get asset batch', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getSignaturesForAsset', '0.000060', 'DAS API - Get signatures for asset', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getNftEditions', '0.000060', 'DAS API - Get NFT editions', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getProgramAccounts', '0.000060', 'Complex RPC - Get program accounts', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getBlock', '0.000060', 'Historical - Get block', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getBlocks', '0.000060', 'Historical - Get blocks', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getBlocksWithLimit', '0.000060', 'Historical - Get blocks with limit', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getTransaction', '0.000060', 'Historical - Get transaction', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getSignaturesForAddress', '0.000060', 'Historical - Get signatures for address', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getBlockTime', '0.000060', 'Historical - Get block time', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getInflationReward', '0.000060', 'Historical - Get inflation reward', '{"provider_credits": 10, "tier": 2}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getTransactionsForAddress', '0.000600', 'Enhanced - Get transactions for address', '{"provider_credits": 100, "tier": 3}'::jsonb, true, 'system', NOW(), NOW()),
  (gen_random_uuid(), 'solana-rpc', 'getValidityProof', '0.000600', 'ZK Proof - Get validity proof', '{"provider_credits": 100, "tier": 3}'::jsonb, true, 'system', NOW(), NOW())
ON CONFLICT (service_id, method) DO UPDATE SET
  cost = EXCLUDED.cost,
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata,
  updated_at = NOW();
