-- Add paymentProvider column to PointsTransaction table
-- Tracks whether payment was made via 'crypto' (on-chain) or 'stripe' (card)

-- Add column (nullable for backwards compatibility with existing records)
ALTER TABLE "PointsTransaction" ADD COLUMN IF NOT EXISTS "paymentProvider" TEXT;

-- Add index for querying by payment provider
CREATE INDEX IF NOT EXISTS "PointsTransaction_paymentProvider_idx" ON "PointsTransaction" ("paymentProvider");

-- Set default value for existing purchase records (crypto was the only option)
UPDATE "PointsTransaction" 
SET "paymentProvider" = 'crypto' 
WHERE "reason" = 'purchase' AND "paymentProvider" IS NULL;

