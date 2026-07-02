ALTER TABLE credit_transactions
  ADD COLUMN IF NOT EXISTS settled_at timestamp;

-- Rows written before marker-aware reservation settlement are ambiguous:
-- exact-cost and uncollected-overage settlements left no reconciliation row to
-- distinguish "already handled" from "dropped waitUntil". Treat them as settled
-- and make the automatic sweep forward-only for marker-aware reservations.
UPDATE credit_transactions
SET settled_at = COALESCE(settled_at, created_at)
WHERE type = 'debit'
  AND metadata->>'type' = 'reservation'
  AND metadata->>'settlement_marker' IS DISTINCT FROM 'credit_reservation_v1'
  AND settled_at IS NULL;

CREATE INDEX IF NOT EXISTS credit_transactions_unsettled_reservations_idx
  ON credit_transactions (created_at)
  WHERE type = 'debit'
    AND metadata->>'type' = 'reservation'
    AND metadata->>'settlement_marker' = 'credit_reservation_v1'
    AND settled_at IS NULL;
