-- Idempotency gate for app-earnings withdrawals (#10878).
--
-- `AppEarningsService.requestWithdrawal` advertised idempotency via
-- `idempotency_key` but enforced it with a SELECT-then-INSERT and no backing
-- unique constraint. Two concurrent (or client-retried) requests with the same
-- key could both pass the existence check and both debit `withdrawable_balance`
-- => double withdrawal, over-crediting the owner's redeemable balance.
--
-- This partial unique index makes the DB — not a prior read — the idempotency
-- gate: a second withdrawal insert with the same (app_id, idempotencyKey) raises
-- 23505, which the service now catches and treats as "already processed".
-- Mirrors 0142_container_billing_idempotency's redeemable-ledger index. Rows
-- without an idempotencyKey (legacy / no-key callers) are excluded by the
-- partial predicate, so they are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS app_earnings_tx_withdrawal_idempotency_uidx
  ON app_earnings_transactions (app_id, (metadata ->> 'idempotencyKey'))
  WHERE type = 'withdrawal' AND (metadata ->> 'idempotencyKey') IS NOT NULL;
