ALTER TYPE "earnings_source" ADD VALUE IF NOT EXISTS 'affiliate';--> statement-breakpoint
ALTER TYPE "earnings_source" ADD VALUE IF NOT EXISTS 'app_owner_revenue_share';--> statement-breakpoint
ALTER TYPE "earnings_source" ADD VALUE IF NOT EXISTS 'creator_revenue_share';--> statement-breakpoint

ALTER TABLE "redeemable_earnings"
  ADD COLUMN IF NOT EXISTS "earned_from_affiliates" numeric(18, 4) DEFAULT '0.0000' NOT NULL;--> statement-breakpoint
ALTER TABLE "redeemable_earnings"
  ADD COLUMN IF NOT EXISTS "earned_from_app_owner_shares" numeric(18, 4) DEFAULT '0.0000' NOT NULL;--> statement-breakpoint
ALTER TABLE "redeemable_earnings"
  ADD COLUMN IF NOT EXISTS "earned_from_creator_shares" numeric(18, 4) DEFAULT '0.0000' NOT NULL;
