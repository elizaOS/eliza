CREATE TABLE IF NOT EXISTS "TradingFeeOutbox" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"tradeType" text NOT NULL,
	"tradeAmount" numeric(24, 8) NOT NULL,
	"tradeId" text,
	"marketId" text,
	"lastError" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TradingFeeOutbox_createdAt_idx" ON "TradingFeeOutbox" USING btree ("createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "TradingFeeOutbox_userId_createdAt_idx" ON "TradingFeeOutbox" USING btree ("userId","createdAt");
