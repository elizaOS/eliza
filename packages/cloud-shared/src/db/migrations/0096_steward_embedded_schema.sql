-- Embedded Steward schema for the shared Eliza Cloud database.
-- Source: steward/packages/db/drizzle, namespaced under schema "steward".

--> statement-breakpoint
-- Source: 0000_black_klaw.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
CREATE TYPE "steward"."approval_queue_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "steward"."policy_type" AS ENUM('spending-limit', 'approved-addresses', 'auto-approve-threshold', 'time-window', 'rate-limit');--> statement-breakpoint
CREATE TYPE "steward"."transaction_status" AS ENUM('pending', 'approved', 'rejected', 'signed', 'broadcast', 'confirmed', 'failed');--> statement-breakpoint
CREATE TABLE "agents" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"wallet_address" varchar(128) NOT NULL,
	"platform_id" varchar(255),
	"erc8004_token_id" varchar(255),
	"owner_user_id" uuid,
	"wallet_type" varchar(32) DEFAULT 'agent',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_queue" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"tx_id" varchar(64) NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"status" "approval_queue_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" varchar(255)
);
--> statement-breakpoint
CREATE TABLE "encrypted_keys" (
	"agent_id" varchar(64) PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"salt" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"type" "policy_type" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"api_key_hash" text NOT NULL,
	"owner_address" varchar(42),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"status" "transaction_status" NOT NULL,
	"to_address" varchar(128) NOT NULL,
	"value" text NOT NULL,
	"data" text,
	"chain_id" integer NOT NULL,
	"tx_hash" varchar(128),
	"policy_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" varchar(64) NOT NULL,
	"provider_account_id" varchar(255) NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"expires_at" integer
);
--> statement-breakpoint
CREATE TABLE "authenticators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"credential_public_key" text NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"credential_device_type" varchar(32),
	"credential_backed_up" boolean DEFAULT false,
	"transports" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authenticators_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"session_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_session_token_unique" UNIQUE("session_token")
);
--> statement-breakpoint
CREATE TABLE "user_tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"role" varchar(32) DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255),
	"email_verified" boolean DEFAULT false,
	"name" varchar(255),
	"image" text,
	"wallet_address" varchar(128),
	"steward_wallet_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "steward"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_queue" ADD CONSTRAINT "approval_queue_tx_id_transactions_id_fk" FOREIGN KEY ("tx_id") REFERENCES "steward"."transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_queue" ADD CONSTRAINT "approval_queue_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "steward"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encrypted_keys" ADD CONSTRAINT "encrypted_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "steward"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "steward"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "steward"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "steward"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authenticators" ADD CONSTRAINT "authenticators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "steward"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "steward"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "steward"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tenants" ADD CONSTRAINT "user_tenants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "steward"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_tenant_id_idx" ON "agents" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_queue_tx_id_idx" ON "approval_queue" USING btree ("tx_id");--> statement-breakpoint
CREATE INDEX "approval_queue_status_idx" ON "approval_queue" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "encrypted_keys_agent_id_idx" ON "encrypted_keys" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "transactions_agent_id_idx" ON "transactions" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_unique" ON "accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "authenticators_user_id_idx" ON "authenticators" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_tenants_unique" ON "user_tenants" USING btree ("user_id","tenant_id");
--> statement-breakpoint
-- Source: 0001_multi_wallet.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Migration: Multi-wallet per agent (EVM + Solana addresses from single creation)
-- Adds chain_family enum, agent_wallets table, and encrypted_chain_keys table.
-- The existing agents.wallet_address and encrypted_keys table are kept as-is
-- for backwards compatibility with existing EVM-only agents.

CREATE TYPE "steward"."chain_family" AS ENUM('evm', 'solana');--> statement-breakpoint

CREATE TABLE "agent_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" varchar(64) NOT NULL,
	"chain_family" "chain_family" NOT NULL,
	"address" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_wallets_agent_chain_idx" UNIQUE ("agent_id", "chain_family")
);
--> statement-breakpoint

CREATE TABLE "encrypted_chain_keys" (
	"agent_id" varchar(64) NOT NULL,
	"chain_family" "chain_family" NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"tag" text NOT NULL,
	"salt" text NOT NULL,
	CONSTRAINT "encrypted_chain_keys_agent_id_chain_family_pk" PRIMARY KEY ("agent_id", "chain_family")
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "agent_wallets" ADD CONSTRAINT "agent_wallets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "steward"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "encrypted_chain_keys" ADD CONSTRAINT "encrypted_chain_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "steward"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX "agent_wallets_agent_id_idx" ON "agent_wallets" ("agent_id");

--> statement-breakpoint
-- Source: 0002_allowed_chains.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Add "allowed-chains" to the policy_type enum.
-- Uses IF NOT EXISTS so the migration is idempotent (safe to re-run).
ALTER TYPE "policy_type" ADD VALUE IF NOT EXISTS 'allowed-chains';

--> statement-breakpoint
-- Source: 0003_safe_black_queen.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
CREATE TYPE "steward"."webhook_delivery_status" AS ENUM('pending', 'delivered', 'failed', 'dead');--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"url" text NOT NULL,
	"status" "webhook_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_next_retry_idx" ON "webhook_deliveries" USING btree ("next_retry_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_tenant_idx" ON "webhook_deliveries" USING btree ("tenant_id");

--> statement-breakpoint
-- Source: 0004_secret_vault.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Secret Vault tables migration
-- Phase 1: Encrypted credential storage + route-based injection

CREATE TABLE IF NOT EXISTS "secrets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "name" varchar(255) NOT NULL,
  "description" text,
  "ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "auth_tag" text NOT NULL,
  "salt" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "rotated_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "secret_routes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" text NOT NULL,
  "secret_id" uuid NOT NULL,
  "host_pattern" varchar(512) NOT NULL,
  "path_pattern" varchar(512) DEFAULT '/*',
  "method" varchar(10) DEFAULT '*',
  "inject_as" varchar(50) NOT NULL,
  "inject_key" varchar(255) NOT NULL,
  "inject_format" varchar(255) DEFAULT '{value}',
  "priority" integer NOT NULL DEFAULT 0,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Indexes for secrets table
CREATE UNIQUE INDEX IF NOT EXISTS "secrets_tenant_name_version_idx" ON "secrets" ("tenant_id", "name", "version");
CREATE INDEX IF NOT EXISTS "secrets_tenant_idx" ON "secrets" ("tenant_id");

-- Indexes for secret_routes table
CREATE INDEX IF NOT EXISTS "secret_routes_tenant_idx" ON "secret_routes" ("tenant_id");
CREATE INDEX IF NOT EXISTS "secret_routes_secret_idx" ON "secret_routes" ("secret_id");
CREATE INDEX IF NOT EXISTS "secret_routes_host_idx" ON "secret_routes" ("host_pattern");

--> statement-breakpoint
-- Source: 0005_proxy_audit_log.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Proxy audit log table migration

CREATE TABLE IF NOT EXISTS "proxy_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" text NOT NULL,
  "tenant_id" text NOT NULL,
  "target_host" varchar(512) NOT NULL,
  "target_path" varchar(512) NOT NULL,
  "method" varchar(10) NOT NULL,
  "status_code" integer NOT NULL,
  "latency_ms" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "proxy_audit_log_tenant_idx" ON "proxy_audit_log" ("tenant_id");
CREATE INDEX IF NOT EXISTS "proxy_audit_log_agent_idx" ON "proxy_audit_log" ("agent_id");
CREATE INDEX IF NOT EXISTS "proxy_audit_log_created_at_idx" ON "proxy_audit_log" ("created_at");

--> statement-breakpoint
-- Source: 0006_tenant_configs.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
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

--> statement-breakpoint
-- Source: 0007_webhook_configs_auto_approval.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Webhook configuration table
CREATE TABLE IF NOT EXISTS "webhook_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "secret" text NOT NULL,
  "events" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "max_retries" integer NOT NULL DEFAULT 5,
  "retry_backoff_ms" integer NOT NULL DEFAULT 60000,
  "description" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "webhook_configs_tenant_idx" ON "webhook_configs" USING btree ("tenant_id");

-- Auto-approval rules table (one per tenant)
CREATE TABLE IF NOT EXISTS "auto_approval_rules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" varchar(64) NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "max_amount_wei" text NOT NULL DEFAULT '0',
  "auto_deny_after_hours" integer,
  "escalate_above_wei" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "auto_approval_rules_tenant_idx" ON "auto_approval_rules" USING btree ("tenant_id");

--> statement-breakpoint
-- Source: 0008_auth_tables.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Steward Auth Migration — adds auth tables + agent extensions
-- Safe to run on existing DB (all IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)

-- New columns on agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_user_id UUID;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS wallet_type VARCHAR(32) DEFAULT 'agent';

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE,
  email_verified BOOLEAN DEFAULT false,
  name VARCHAR(255),
  image TEXT,
  wallet_address VARCHAR(128),
  steward_wallet_id VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- WebAuthn authenticators (passkeys)
CREATE TABLE IF NOT EXISTS authenticators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  credential_public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  credential_device_type VARCHAR(32),
  credential_backed_up BOOLEAN DEFAULT false,
  transports TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS authenticators_user_id_idx ON authenticators(user_id);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);

-- OAuth accounts
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(64) NOT NULL,
  provider_account_id VARCHAR(255) NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_provider_unique ON accounts(provider, provider_account_id);
CREATE INDEX IF NOT EXISTS accounts_user_id_idx ON accounts(user_id);

-- User-tenant membership
CREATE TABLE IF NOT EXISTS user_tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role VARCHAR(32) NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_tenants_unique ON user_tenants(user_id, tenant_id);

--> statement-breakpoint
-- Source: 0009_auth_kv_store.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Migration: auth_kv_store
-- Persistent key-value store for WebAuthn challenges and magic-link tokens.
-- Used when Redis is unavailable but Postgres-backed persistence is desired.
-- Both tables share a single auth_kv_store table partitioned by namespace.

CREATE TABLE IF NOT EXISTS auth_kv_store (
  id          TEXT        NOT NULL,
  namespace   TEXT        NOT NULL,
  value       TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (id, namespace)
);

-- Index for efficient expired-row cleanup queries
CREATE INDEX IF NOT EXISTS auth_kv_store_expires_idx
  ON auth_kv_store (expires_at);

-- Optional: schedule a periodic sweep to remove fully-expired entries.
-- Application code also deletes rows lazily on read, so this is optional.
-- Example (requires pg_cron extension):
-- SELECT cron.schedule('auth-kv-cleanup', '*/10 * * * *',
--   $$DELETE FROM auth_kv_store WHERE expires_at < now()$$);

--> statement-breakpoint
-- Source: 0010_per_tenant_cors.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Per-tenant CORS: adds allowed_origins column to tenant_configs
-- Safe to run on existing DB (ADD COLUMN IF NOT EXISTS)

ALTER TABLE tenant_configs
  ADD COLUMN IF NOT EXISTS allowed_origins TEXT[] NOT NULL DEFAULT '{}';

--> statement-breakpoint
-- Source: 0011_refresh_tokens.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Migration: refresh_tokens table
-- Stores long-lived refresh tokens (30 days) that can be exchanged for new access tokens.
-- One-time use: each refresh rotates both tokens and deletes the old refresh token.

CREATE TABLE IF NOT EXISTS "refresh_tokens" (
  "id"         TEXT PRIMARY KEY,
  "user_id"    TEXT NOT NULL,
  "tenant_id"  TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "refresh_tokens_token_hash_idx" ON "refresh_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx"   ON "refresh_tokens" ("user_id");

--> statement-breakpoint
-- Source: 0012_tenant_join_modes.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Migration: Add join_mode to tenant_configs
-- Controls how users can join a tenant:
--   'open'   — anyone authenticating with this tenantId gets auto-linked (default, backward compatible)
--   'invite' — user must have an existing user_tenants link (invited by admin)
--   'closed' — no new members allowed at all

ALTER TABLE tenant_configs ADD COLUMN IF NOT EXISTS join_mode VARCHAR(16) NOT NULL DEFAULT 'open';

--> statement-breakpoint
-- Source: 0013_standalone_policies.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
CREATE TABLE IF NOT EXISTS policy_templates (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  rules JSONB NOT NULL DEFAULT '[]',
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS policy_templates_tenant_idx ON policy_templates(tenant_id);

--> statement-breakpoint
-- Source: 0014_erc8004_registrations.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Migration: ERC-8004 agent registration, reputation cache, and registry index tables.

CREATE TABLE IF NOT EXISTS agent_registrations (
  id              SERIAL PRIMARY KEY,
  tenant_id       VARCHAR(128) NOT NULL,
  agent_id        VARCHAR(128) NOT NULL,
  chain_id        INTEGER NOT NULL,
  token_id        VARCHAR(256),
  tx_hash         VARCHAR(128),
  registry_address VARCHAR(64) NOT NULL,
  agent_card_uri  TEXT,
  agent_card_json JSONB,
  status          VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, agent_id, chain_id)
);

CREATE TABLE IF NOT EXISTS reputation_cache (
  id              SERIAL PRIMARY KEY,
  agent_id        VARCHAR(128) NOT NULL,
  chain_id        INTEGER NOT NULL,
  token_id        VARCHAR(256) NOT NULL,
  score_onchain   NUMERIC(5,2) NOT NULL DEFAULT 0,
  score_internal  NUMERIC(5,2) NOT NULL DEFAULT 0,
  score_combined  NUMERIC(5,2) NOT NULL DEFAULT 0,
  feedback_count  INTEGER NOT NULL DEFAULT 0,
  last_updated    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent_id, chain_id)
);

CREATE TABLE IF NOT EXISTS registry_index (
  id              SERIAL PRIMARY KEY,
  chain_id        INTEGER NOT NULL,
  name            VARCHAR(64) NOT NULL,
  rpc_url         TEXT NOT NULL,
  registry_address VARCHAR(64) NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id)
);

--> statement-breakpoint
-- Source: 0015_reputation_policy_types.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
ALTER TYPE policy_type ADD VALUE IF NOT EXISTS 'reputation-threshold';
ALTER TYPE policy_type ADD VALUE IF NOT EXISTS 'reputation-scaling';

--> statement-breakpoint
-- Source: 0016_tenant_email_config.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Per-tenant email config: adds email_config column to tenant_configs
-- Safe to run on existing DB (ADD COLUMN IF NOT EXISTS)

ALTER TABLE tenant_configs
  ADD COLUMN IF NOT EXISTS email_config JSONB;

--> statement-breakpoint
-- Source: 0017_user_wallet_chain.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "wallet_chain" varchar(16) DEFAULT 'ethereum';

--> statement-breakpoint
-- Source: 0018_tenant_owner_address_widen.sql
CREATE SCHEMA IF NOT EXISTS "steward";
SET search_path TO "steward";
-- Widen tenants.owner_address to fit Solana tenant ids ("solana:<base58>" up to ~51 chars)
-- Was varchar(42) (designed for EIP-55 EVM addresses)
ALTER TABLE "tenants" ALTER COLUMN "owner_address" TYPE varchar(128);

--> statement-breakpoint
RESET search_path;
