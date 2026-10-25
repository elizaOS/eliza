-- Scope `crypto_payments.transaction_hash` uniqueness to ACTIVE payments only.
--
-- The previous unconditional unique index permanently burned a tx hash even
-- after a payment expired or failed. We keep the unique constraint, but only
-- for payments in active lifecycle states. This still prevents the
-- attachTransaction race (two concurrent attaches passing the in-tx SELECT)
-- while letting failed/expired rows coexist with a future successful retry.

DROP INDEX IF EXISTS crypto_payments_transaction_hash_unique_idx;

CREATE UNIQUE INDEX IF NOT EXISTS crypto_payments_active_tx_hash_unique_idx
    ON crypto_payments(transaction_hash)
    WHERE transaction_hash IS NOT NULL
      AND status IN ('pending', 'broadcast', 'confirmed');
