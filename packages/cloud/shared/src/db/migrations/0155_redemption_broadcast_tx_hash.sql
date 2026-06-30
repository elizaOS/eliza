-- Crash-recovery support for the payout processor (#10553).
--
-- Records the on-chain transaction hash the MOMENT a redemption transfer is
-- broadcast — before confirmation — so a worker that dies mid-payout can be
-- recovered without risking a double-pay:
--   * a stuck `processing` row WITH a broadcast hash means a transfer may be
--     in-flight on-chain → it must NEVER be auto-retried (a re-broadcast would
--     double-pay); it is routed to operator reconciliation instead.
--   * a stuck EVM `processing` row WITHOUT a broadcast hash means the worker died
--     before submitting any transaction → it is provably safe to re-approve.
--
-- Distinct from `tx_hash`, which is only written once the transfer CONFIRMS.
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS, nullable, no backfill, no drop.
-- The column defaults NULL, so every pre-existing row is treated as "not
-- broadcast" — correct, since any redemption created before this migration is
-- already completed/failed or still approved, never mid-broadcast.

ALTER TABLE "token_redemptions" ADD COLUMN IF NOT EXISTS "broadcast_tx_hash" text;
