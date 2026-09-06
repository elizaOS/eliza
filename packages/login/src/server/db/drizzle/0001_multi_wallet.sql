-- Migration: Multi-wallet per agent (EVM + Solana addresses from single creation)
-- Adds chain_family enum, agent_wallets table, and encrypted_chain_keys table.
-- The existing agents.wallet_address and encrypted_keys table are kept as-is
-- for backwards compatibility with existing EVM-only agents.

CREATE TYPE "public"."chain_family" AS ENUM('evm', 'solana');--> statement-breakpoint

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
 ALTER TABLE "agent_wallets" ADD CONSTRAINT "agent_wallets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "encrypted_chain_keys" ADD CONSTRAINT "encrypted_chain_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint

CREATE INDEX "agent_wallets_agent_id_idx" ON "agent_wallets" ("agent_id");
