ALTER TYPE "chain_family" ADD VALUE IF NOT EXISTS 'bitcoin';
--> statement-breakpoint
ALTER TABLE "agent_wallets"
  ADD COLUMN IF NOT EXISTS "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;
