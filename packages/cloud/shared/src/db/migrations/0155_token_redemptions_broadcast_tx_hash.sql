-- Record the payout transaction hash at BROADCAST time (the moment
-- writeContract / sendRawTransaction returns), before on-chain confirmation.
--
-- `tx_hash` is only written once a payout is confirmed (status = completed), so
-- it cannot tell crash-recovery apart "never broadcast" from "broadcast, still
-- awaiting confirmation". `broadcast_tx_hash` closes that gap:
--   * NULL  → the payout provably never left our process; safe to re-approve.
--   * NOT NULL → a transaction may be in flight on-chain; NEVER re-approve
--                (re-broadcasting would double-pay) — reconcile on-chain.
--
-- Additive + idempotent: nullable column, ADD COLUMN IF NOT EXISTS, no backfill,
-- no drops. Existing rows keep NULL, which is correct (no in-flight broadcast).
--
-- Rollback: ALTER TABLE "token_redemptions" DROP COLUMN IF EXISTS "broadcast_tx_hash";

ALTER TABLE "token_redemptions" ADD COLUMN IF NOT EXISTS "broadcast_tx_hash" text;
