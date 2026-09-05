-- Add the durable ambiguous-broadcast state on the upgrade path after 0087.
ALTER TYPE "public"."transaction_status" ADD VALUE IF NOT EXISTS 'outcome_unknown';
--> statement-breakpoint

-- Rotate receipt-poller batches so long-lived missing receipts cannot starve
-- newer broadcast or ambiguous transactions.
ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "receipt_polled_at" timestamp with time zone;
