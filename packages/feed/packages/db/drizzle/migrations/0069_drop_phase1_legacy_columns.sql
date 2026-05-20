-- Phase 1/2 cleanup: drop columns from removed crypto stack (Privy wallets, Solana, Agent0, ERC-8004)
-- These columns have zero application code references after Phase 1/2 feature removal.
-- NOTE: privyId is intentionally KEPT for the Steward migration grace period (drop in Phase 3).

-- Privy embedded wallets (never used post-Phase 1)
ALTER TABLE "User" DROP COLUMN IF EXISTS "privyWalletId";
ALTER TABLE "User" DROP COLUMN IF EXISTS "privySolanaWalletId";

-- Offline wallet infrastructure (removed Phase 1)
ALTER TABLE "User" DROP COLUMN IF EXISTS "offlineWalletReady";
ALTER TABLE "User" DROP COLUMN IF EXISTS "offlineWalletReadyAt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "solanaOfflineWalletReady";
ALTER TABLE "User" DROP COLUMN IF EXISTS "solanaOfflineWalletReadyAt";

-- Solana wallet address (Solana removed Phase 1)
ALTER TABLE "User" DROP COLUMN IF EXISTS "solanaWalletAddress";

-- Agent0 columns on User table (Agent0 removed Phase 1; agent0 columns on agents table are kept)
ALTER TABLE "User" DROP COLUMN IF EXISTS "agent0FeedbackCount";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agent0MetadataCID";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agent0RegisteredAt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agent0TokenId";
ALTER TABLE "User" DROP COLUMN IF EXISTS "agent0TrustScore";

-- Solana registration (removed Phase 1)
ALTER TABLE "User" DROP COLUMN IF EXISTS "solanaRegistered";
ALTER TABLE "User" DROP COLUMN IF EXISTS "solanaRegistryAssetId";
ALTER TABLE "User" DROP COLUMN IF EXISTS "solanaMetadataUri";
ALTER TABLE "User" DROP COLUMN IF EXISTS "solanaRegistrationTxHash";
ALTER TABLE "User" DROP COLUMN IF EXISTS "solanaRegisteredAt";

-- On-chain registration flag (ERC-8004 removed Phase 1)
ALTER TABLE "User" DROP COLUMN IF EXISTS "onChainRegistered";

-- Profile chain sync (dead — tied to removed ERC-8004 on-chain sync)
ALTER TABLE "User" DROP COLUMN IF EXISTS "profileChainSyncNeeded";
ALTER TABLE "User" DROP COLUMN IF EXISTS "profileChainSyncAt";
ALTER TABLE "User" DROP COLUMN IF EXISTS "profileChainSyncError";

-- Blockchain registration tx metadata (on-chain registration removed)
ALTER TABLE "User" DROP COLUMN IF EXISTS "registrationTxHash";
ALTER TABLE "User" DROP COLUMN IF EXISTS "registrationBlockNumber";
ALTER TABLE "User" DROP COLUMN IF EXISTS "registrationGasUsed";

-- Drop orphaned indexes (columns no longer exist)
DROP INDEX IF EXISTS "User_profileChainSyncNeeded_onChainRegistered_idx";
