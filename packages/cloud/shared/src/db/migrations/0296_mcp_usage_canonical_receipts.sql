-- Adds the canonical, fee-inclusive MCP usage receipt without reinterpreting
-- the historical credits_charged base-price points column (100 points = $1).
ALTER TABLE "mcp_usage" ADD COLUMN IF NOT EXISTS "base_amount_usd" numeric(18, 6);
ALTER TABLE "mcp_usage" ADD COLUMN IF NOT EXISTS "affiliate_fee_usd" numeric(18, 6);
ALTER TABLE "mcp_usage" ADD COLUMN IF NOT EXISTS "platform_fee_usd" numeric(18, 6);
ALTER TABLE "mcp_usage" ADD COLUMN IF NOT EXISTS "total_amount_usd" numeric(18, 6);
ALTER TABLE "mcp_usage" ADD COLUMN IF NOT EXISTS "fee_components_known" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Old application writers remain value-preserving while migration and deploy
-- overlap. New code supplies every canonical component and marks it known.
CREATE OR REPLACE FUNCTION mcp_usage_fill_legacy_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.base_amount_usd IS NULL THEN
    NEW.base_amount_usd := round(NEW.credits_charged / 100, 6);
  END IF;
  IF NEW.affiliate_fee_usd IS NULL THEN NEW.affiliate_fee_usd := 0; END IF;
  IF NEW.platform_fee_usd IS NULL THEN NEW.platform_fee_usd := 0; END IF;
  IF NEW.total_amount_usd IS NULL THEN NEW.total_amount_usd := NEW.base_amount_usd; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS mcp_usage_fill_legacy_receipt ON mcp_usage;
CREATE TRIGGER mcp_usage_fill_legacy_receipt
BEFORE INSERT ON mcp_usage FOR EACH ROW EXECUTE FUNCTION mcp_usage_fill_legacy_receipt();
--> statement-breakpoint
UPDATE "mcp_usage"
SET "base_amount_usd" = round("credits_charged" / 100, 6),
    "affiliate_fee_usd" = 0,
    "platform_fee_usd" = 0,
    "total_amount_usd" = round("credits_charged" / 100, 6),
    "fee_components_known" = false
WHERE "base_amount_usd" IS NULL OR "affiliate_fee_usd" IS NULL
   OR "platform_fee_usd" IS NULL OR "total_amount_usd" IS NULL;
--> statement-breakpoint
ALTER TABLE "mcp_usage" ALTER COLUMN "base_amount_usd" SET NOT NULL;
ALTER TABLE "mcp_usage" ALTER COLUMN "affiliate_fee_usd" SET NOT NULL;
ALTER TABLE "mcp_usage" ALTER COLUMN "platform_fee_usd" SET NOT NULL;
ALTER TABLE "mcp_usage" ALTER COLUMN "total_amount_usd" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "mcp_usage" ADD CONSTRAINT "mcp_usage_canonical_receipt_check" CHECK (
    base_amount_usd >= 0 AND affiliate_fee_usd >= 0 AND platform_fee_usd >= 0
    AND total_amount_usd = base_amount_usd + affiliate_fee_usd + platform_fee_usd
    AND base_amount_usd::text <> 'NaN' AND affiliate_fee_usd::text <> 'NaN'
    AND platform_fee_usd::text <> 'NaN' AND total_amount_usd::text <> 'NaN'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
