-- Container-billing idempotency hardening.
--
-- 1. Earnings-conversion idempotency: at most one `credit_conversion` ledger
--    entry per idempotency key (one container charge per period). Partial so
--    only keyed conversions are constrained; pre-existing conversions carry no
--    key and are unaffected, so this is safe on historical data.
CREATE UNIQUE INDEX IF NOT EXISTS redeemable_earnings_ledger_conversion_idempotency_idx
  ON redeemable_earnings_ledger ((metadata ->> 'idempotency_key'))
  WHERE entry_type = 'credit_conversion' AND (metadata ->> 'idempotency_key') IS NOT NULL;

-- 2. Dedupe any historical duplicate successful billing rows before adding the
--    unique index, otherwise the index creation would fail on existing data.
--    Keep the earliest row per (container, period) by (created_at, id).
DELETE FROM container_billing_records cbr
USING container_billing_records dup
WHERE cbr.status = 'success'
  AND dup.status = 'success'
  AND cbr.container_id = dup.container_id
  AND cbr.billing_period_start = dup.billing_period_start
  AND (cbr.created_at, cbr.id) > (dup.created_at, dup.id);

-- 3. Enforce at most one successful charge per container per billing period.
--    Partial so retries of a failed/insufficient-credits period stay allowed.
CREATE UNIQUE INDEX IF NOT EXISTS container_billing_records_period_unique
  ON container_billing_records (container_id, billing_period_start)
  WHERE status = 'success';
