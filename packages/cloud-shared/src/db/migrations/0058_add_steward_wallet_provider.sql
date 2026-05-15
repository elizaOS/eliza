-- Migration: Add Steward wallet provider support (dual provider routing)
-- Phase 1 of Privy → Steward wallet migration.
--
-- This migration is additive and zero-downtime safe:
--   - Adds wallet_provider column (defaults to 'privy' for existing rows)
--   - Adds Steward reference columns (nullable)
--   - Makes privy_wallet_id nullable for future Steward-only wallets
--   - Adds a CHECK constraint ensuring exactly one provider ID is present

BEGIN;

-- 1. Add wallet_provider routing column (existing rows get 'privy')
ALTER TABLE "agent_server_wallets"
  ADD COLUMN IF NOT EXISTS "wallet_provider" TEXT NOT NULL DEFAULT 'privy';

-- 2. Add Steward reference columns
ALTER TABLE "agent_server_wallets"
  ADD COLUMN IF NOT EXISTS "steward_agent_id" TEXT,
  ADD COLUMN IF NOT EXISTS "steward_tenant_id" TEXT;

-- 3. Make privy_wallet_id nullable (Steward wallets won't have one)
ALTER TABLE "agent_server_wallets"
  ALTER COLUMN "privy_wallet_id" DROP NOT NULL;

-- 4. Constraint: exactly one provider's ID must be present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'wallet_provider_id_check'
      AND conrelid = 'public.agent_server_wallets'::regclass
  ) THEN
    ALTER TABLE "agent_server_wallets"
      ADD CONSTRAINT "wallet_provider_id_check" CHECK (
        ("wallet_provider" = 'privy'   AND "privy_wallet_id" IS NOT NULL) OR
        ("wallet_provider" = 'steward' AND "steward_agent_id" IS NOT NULL)
      );
  END IF;
END $$;

-- 5. Indexes for Steward lookups
CREATE INDEX IF NOT EXISTS "idx_asw_steward_agent"
  ON "agent_server_wallets" ("steward_agent_id")
  WHERE "steward_agent_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_asw_wallet_provider"
  ON "agent_server_wallets" ("wallet_provider");

COMMIT;
