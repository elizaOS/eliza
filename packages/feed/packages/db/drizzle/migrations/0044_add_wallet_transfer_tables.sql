-- Add wallet transfer log and daily limit tables for in-app wallet management
-- These support token/ETH/NFT transfers initiated through Babylon, plus daily spending limits

CREATE TABLE IF NOT EXISTS "WalletTransferLog" (
  "id" text PRIMARY KEY NOT NULL,
  "userId" text NOT NULL,
  "fromAddress" text NOT NULL,
  "toAddress" text NOT NULL,
  "tokenAddress" text,
  "tokenId" text,
  "amount" text NOT NULL,
  "txHash" text,
  "chainId" integer NOT NULL,
  "status" text NOT NULL,
  "type" text NOT NULL,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "confirmedAt" timestamp,
  "usdValueAtTime" numeric(18, 2),
  "ipAddress" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "WalletTransferLog_userId_idx" ON "WalletTransferLog" USING btree ("userId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "WalletTransferLog_userId_createdAt_idx" ON "WalletTransferLog" USING btree ("userId", "createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "WalletTransferLog_fromAddress_idx" ON "WalletTransferLog" USING btree ("fromAddress");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "WalletTransferLog_toAddress_idx" ON "WalletTransferLog" USING btree ("toAddress");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "WalletTransferLog_txHash_idx" ON "WalletTransferLog" USING btree ("txHash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "WalletTransferLog_status_idx" ON "WalletTransferLog" USING btree ("status");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "WalletTransferLimit" (
  "userId" text PRIMARY KEY NOT NULL,
  "dailyLimitUsd" numeric(18, 2) DEFAULT '1000.00' NOT NULL,
  "dailySpentUsd" numeric(18, 2) DEFAULT '0.00' NOT NULL,
  "lastResetAt" timestamp DEFAULT now() NOT NULL,
  "elevatedUntil" timestamp,
  "elevatedLimitUsd" numeric(18, 2)
);
