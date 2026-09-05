CREATE UNIQUE INDEX "billing_funding_allocations_credit_settle_idx"
  ON "billing_funding_allocations" USING btree ("purchased_credit_settlement_transaction_id")
  WHERE "purchased_credit_settlement_transaction_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_funding_allocations_credit_refund_idx"
  ON "billing_funding_allocations" USING btree ("purchased_credit_refund_transaction_id")
  WHERE "purchased_credit_refund_transaction_id" IS NOT NULL;
--> statement-breakpoint
-- This transaction-local escape hatch supports complete account erasure and
-- guards against accidental application mutations only. PostgreSQL custom
-- settings are writable by any SQL-capable session, so this function is not an
-- audit-grade hostile-session boundary; that would require a dedicated
-- database role unavailable to ordinary application connections.
CREATE OR REPLACE FUNCTION reject_subscription_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('eliza.subscription_account_deletion_authority', true) = 'on' THEN
    -- Both guards are statement-level, where PostgreSQL ignores the trigger return value;
    -- NULL therefore permits the statement instead of cancelling an individual row.
    RETURN NULL;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END
$$;
