-- Ad SSP money-safety hardening (#10687 / #10942 review).
--
-- 1. ad_slot_events.payout_settled_at — an impression row with revenue and a
--    NULL payout_settled_at is a durable PENDING publisher payout (written in
--    the same transaction as the advertiser debit); the service settles it
--    idempotently after commit and retries unsettled rows on later serves.
-- 2. Partial index for the cheap pending-payout scan.
-- 3. ad_slots.floor_cpm default 1.0000 -> 10.0000: the advertiser debit is
--    whole cents, so a per-impression price under $0.01 is refused (it would
--    mint publisher earnings against a $0.00 debit). $10 CPM is the minimum
--    billable floor; the default should be serveable out of the box.
-- Additive + idempotent: IF NOT EXISTS / SET DEFAULT, no backfill.

ALTER TABLE "ad_slot_events" ADD COLUMN IF NOT EXISTS "payout_settled_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ad_slot_events_unsettled_payout_idx" ON "ad_slot_events" USING btree ("created_at") WHERE "payout_settled_at" IS NULL AND "type" = 'impression';--> statement-breakpoint
ALTER TABLE "ad_slots" ALTER COLUMN "floor_cpm" SET DEFAULT '10.0000';
