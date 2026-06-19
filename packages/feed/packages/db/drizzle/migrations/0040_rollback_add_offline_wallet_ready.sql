ALTER TABLE "User"
DROP COLUMN IF EXISTS "offlineWalletReadyAt";

ALTER TABLE "User"
DROP COLUMN IF EXISTS "offlineWalletReady";
