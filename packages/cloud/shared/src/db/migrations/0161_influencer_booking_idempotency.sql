-- Money-safety hardening for the influencer-booking escrow (#10687, PR #10951
-- blocking review).
--
-- The fund flow is now booking-row-first: the row is inserted in status
-- 'funding' BEFORE the keyed escrow debit and CAS-finalized to 'offered' after
-- the debit commits, recording the escrow debit's credit_transactions id on
-- the row ("escrow_transaction_id"). "idempotency_key" is an optional
-- client-supplied create key: a lost-response create retry with the same key
-- resumes the original booking instead of funding a second escrow. The unique
-- index makes the DB — not a prior read — the dedupe gate (concurrent same-key
-- creates collapse to one row via ON CONFLICT DO NOTHING). Rows without a key
-- (no-key callers) are unaffected: Postgres unique indexes admit multiple NULLs.
ALTER TABLE "influencer_bookings" ADD COLUMN IF NOT EXISTS "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "influencer_bookings" ADD COLUMN IF NOT EXISTS "escrow_transaction_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "influencer_bookings_idempotency_key_uidx"
  ON "influencer_bookings" ("idempotency_key");
