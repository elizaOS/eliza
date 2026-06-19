ALTER TABLE "User"
ADD COLUMN "offlineWalletReady" boolean DEFAULT false NOT NULL;

ALTER TABLE "User"
ADD COLUMN "offlineWalletReadyAt" timestamp;
