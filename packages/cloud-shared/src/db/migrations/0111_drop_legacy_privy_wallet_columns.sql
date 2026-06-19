-- Migration: retire legacy wallet provider routing
--
-- Steward is now the only supported server-wallet backend. This migration
-- drops the legacy provider discriminator and Privy wallet id after asserting
-- that no legacy rows remain.

BEGIN;

DO $$
DECLARE
  legacy_wallet_count BIGINT;
BEGIN
  SELECT COUNT(*)
    INTO legacy_wallet_count
    FROM "agent_server_wallets"
    WHERE "wallet_provider" IS DISTINCT FROM 'steward'
       OR "privy_wallet_id" IS NOT NULL;

  IF legacy_wallet_count > 0 THEN
    RAISE EXCEPTION
      'Legacy wallet cleanup aborted: % agent_server_wallets rows still reference legacy wallet provider data.',
      legacy_wallet_count;
  END IF;
END $$;

DROP INDEX IF EXISTS "agent_server_wallets_privy_wallet_idx";
DROP INDEX IF EXISTS "agent_server_wallets_wallet_provider_idx";

ALTER TABLE "agent_server_wallets"
  DROP COLUMN IF EXISTS "privy_wallet_id",
  DROP COLUMN IF EXISTS "wallet_provider";

COMMIT;
