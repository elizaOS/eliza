ALTER TABLE "User"
ADD COLUMN "privySolanaWalletId" text,
ADD COLUMN "solanaOfflineWalletReady" boolean DEFAULT false NOT NULL,
ADD COLUMN "solanaOfflineWalletReadyAt" timestamp,
ADD COLUMN "solanaWalletAddress" text,
ADD COLUMN "solanaRegistered" boolean DEFAULT false NOT NULL,
ADD COLUMN "solanaRegistryAssetId" text,
ADD COLUMN "solanaMetadataUri" text,
ADD COLUMN "solanaRegistrationTxHash" text,
ADD COLUMN "solanaRegisteredAt" timestamp;

ALTER TABLE "User"
ADD CONSTRAINT "User_solanaWalletAddress_unique" UNIQUE("solanaWalletAddress");
