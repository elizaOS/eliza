-- Refund-linkage partial indexes for the MCP settlement sweep (#27992 r2 F3).
--
-- The orphan-precharge sweep's finder and atomic claim compute a correlated
-- SUM over refund rows matching either linkage arm:
--   r.metadata->>'mcp_precharge_refund_for'   = <debit id>
--   r.metadata->>'reservation_transaction_id' = <debit id>
-- Without an expression index each sum scans the full refund population for
-- every examined candidate on the every-minute recovery cron; on a mature
-- ledger that risks timing out the recovery lane. Both indexes are partial on
-- type='refund' so only the refund subset is indexed. The schema
-- (credit-transactions.ts) declares the same indexes so test databases pushed
-- via drizzle-kit carry them (pg_indexes parity, matching the round-4
-- mcp_precharge_idx pattern).
CREATE INDEX IF NOT EXISTS "credit_transactions_mcp_precharge_refund_link_idx"
  ON "credit_transactions" USING btree (("metadata"->>'mcp_precharge_refund_for'))
  WHERE "credit_transactions"."type" = 'refund'
    AND "credit_transactions"."metadata"->>'mcp_precharge_refund_for' IS NOT NULL;

CREATE INDEX IF NOT EXISTS "credit_transactions_reservation_refund_link_idx"
  ON "credit_transactions" USING btree (("metadata"->>'reservation_transaction_id'))
  WHERE "credit_transactions"."type" = 'refund'
    AND "credit_transactions"."metadata"->>'reservation_transaction_id' IS NOT NULL;
