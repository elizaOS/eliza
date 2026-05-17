-- Add GIN index on app_earnings_transactions metadata column for efficient JSONB containment queries
-- This improves performance of findTransactionByPaymentIntent which uses the @> operator

CREATE INDEX IF NOT EXISTS app_earnings_transactions_metadata_gin_idx
ON app_earnings_transactions USING GIN (metadata);
