ALTER TABLE "ad_accounts" ADD COLUMN IF NOT EXISTS "spend_cap_credits" numeric(12,2);
ALTER TABLE "ad_campaigns" ADD COLUMN IF NOT EXISTS "spend_cap_credits" numeric(12,2);
