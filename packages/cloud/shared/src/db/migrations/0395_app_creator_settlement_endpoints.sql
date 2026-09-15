-- Replace the complete validator atomically so existing v1 receipts retain their rules.
-- The replacement stays together to avoid exposing mixed receipt versions during deployment.
-- Preserve historical receipt rules while new settlements conserve committed creator endpoints.
ALTER TABLE app_reservation_settlements
  ADD COLUMN creator_rule_version integer NOT NULL DEFAULT 1,
  ADD COLUMN creator_original_ledger_entry_id uuid,
  ADD COLUMN creator_initial_amount numeric(16,4),
  ADD COLUMN creator_final_amount numeric(16,4),
  ADD CONSTRAINT app_reservation_creator_original_fk FOREIGN KEY (creator_original_ledger_entry_id)
    REFERENCES redeemable_earnings_ledger(id) ON DELETE RESTRICT,
  ADD CONSTRAINT app_reservation_creator_rule_check CHECK (
    (creator_rule_version = 1 AND creator_original_ledger_entry_id IS NULL
      AND creator_initial_amount IS NULL AND creator_final_amount IS NULL)
    OR (creator_rule_version = 2 AND creator_initial_amount IS NOT NULL
      AND creator_final_amount IS NOT NULL AND creator_initial_amount >= 0 AND creator_final_amount >= 0));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_app_reservation_settlement_receipt() RETURNS trigger AS $$
DECLARE
  reservation_row credit_transactions%ROWTYPE;
  adjustment_row credit_transactions%ROWTYPE;
  creator_ledger_amount numeric;
  creator_expected_movement numeric;
  original_creator redeemable_earnings_ledger%ROWTYPE;
  initial_creator_amount numeric;
  final_creator_amount numeric;
  creator_ledger_user uuid;
  creator_ledger_source text;
  app_projection_app uuid;
  app_projection_user uuid;
  app_projection_amount numeric;
  app_projection_ledger text;
BEGIN
  SELECT * INTO reservation_row
  FROM credit_transactions
  WHERE id = NEW.reservation_transaction_id
    AND organization_id = NEW.organization_id
  FOR UPDATE;
  IF NOT FOUND
     OR reservation_row.type <> 'debit'
     OR reservation_row.metadata->>'type' <> 'app_chat_reservation'
     OR reservation_row.metadata->>'settlement_marker' <> 'app_chat_reservation_v1'
     OR lower(reservation_row.metadata->>'appId') IS DISTINCT FROM NEW.app_id::text
     OR lower(reservation_row.metadata->>'userId') IS DISTINCT FROM NEW.user_id::text
     OR lower(NULLIF(reservation_row.metadata->>'creatorUserId', ''))::uuid
          IS DISTINCT FROM NEW.creator_user_id
     OR abs(reservation_row.amount) IS DISTINCT FROM NEW.reserved_total_cost
     OR COALESCE(reservation_row.metadata->>'reserved_amount',
                 reservation_row.metadata->>'baseCost')::numeric
          IS DISTINCT FROM NEW.reserved_base_cost
     OR EXISTS (
       SELECT 1 FROM app_reservation_settlement_quarantines
       WHERE reservation_transaction_id = NEW.reservation_transaction_id
     ) THEN
    RAISE EXCEPTION 'app reservation receipt does not match immutable reservation facts'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlements_reservation_match';
  END IF;

  IF round(NEW.reserved_base_cost * (1 + NEW.markup_percentage / 100), 6)
       IS DISTINCT FROM NEW.reserved_total_cost
     OR round(NEW.actual_base_cost * (1 + NEW.markup_percentage / 100), 6)
       IS DISTINCT FROM NEW.actual_total_cost
     OR NEW.actual_total_cost - NEW.reserved_total_cost
       IS DISTINCT FROM NEW.organization_adjustment
     OR round((NEW.actual_base_cost - NEW.reserved_base_cost)
       * NEW.markup_percentage / 100, 6) IS DISTINCT FROM NEW.creator_adjustment
     OR NEW.actual_base_cost - NEW.reserved_base_cost
       IS DISTINCT FROM NEW.platform_adjustment THEN
    RAISE EXCEPTION 'app reservation receipt economics are inconsistent'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlements_economic_match';
  END IF;

  IF NEW.credit_transaction_id IS NOT NULL THEN
    SELECT * INTO adjustment_row
    FROM credit_transactions
    WHERE id = NEW.credit_transaction_id
      AND organization_id = NEW.organization_id;
  END IF;
  IF (NEW.outcome = 'refund' AND (
        NEW.credit_transaction_id IS NULL OR adjustment_row.type <> 'refund'
        OR adjustment_row.amount IS DISTINCT FROM -NEW.organization_adjustment
        OR adjustment_row.stripe_payment_intent_id
          IS DISTINCT FROM 'reconcile-refund:' || NEW.reservation_transaction_id::text
      ))
     OR (NEW.outcome = 'overage' AND (
        NEW.credit_transaction_id IS NULL OR adjustment_row.type <> 'debit'
        OR adjustment_row.amount IS DISTINCT FROM -NEW.organization_adjustment
        OR adjustment_row.stripe_payment_intent_id
          IS DISTINCT FROM 'reconcile-charge:' || NEW.reservation_transaction_id::text
      ))
     OR (NEW.outcome IN ('none', 'uncollected_overage')
       AND NEW.credit_transaction_id IS NOT NULL) THEN
    RAISE EXCEPTION 'app reservation receipt adjustment ledger does not match outcome'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlements_adjustment_match';
  END IF;

  creator_expected_movement := trunc(NEW.creator_adjustment, 4);
  IF NEW.creator_rule_version = 2 THEN
    initial_creator_amount := trunc(round(NEW.reserved_base_cost * NEW.markup_percentage / 100, 6), 4);
    final_creator_amount := CASE WHEN NEW.outcome = 'uncollected_overage' THEN initial_creator_amount
      ELSE trunc(round(NEW.actual_base_cost * NEW.markup_percentage / 100, 6), 4) END;
    IF NEW.creator_initial_amount IS DISTINCT FROM initial_creator_amount
       OR NEW.creator_final_amount IS DISTINCT FROM final_creator_amount THEN
      RAISE EXCEPTION 'app creator endpoints differ from collected settlement authority'
        USING ERRCODE = '23514', CONSTRAINT = 'app_reservation_creator_endpoint_match';
    END IF;
    IF initial_creator_amount = 0 THEN
      IF NEW.creator_original_ledger_entry_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM redeemable_earnings_ledger
        WHERE metadata->>'chargeTransactionId' = NEW.reservation_transaction_id::text
      ) THEN
        RAISE EXCEPTION 'subunit original app earning must have explicit absent ledger authority'
          USING ERRCODE = '23514', CONSTRAINT = 'app_reservation_creator_original_match';
      END IF;
    ELSE
      SELECT * INTO original_creator FROM redeemable_earnings_ledger
      WHERE id = NEW.creator_original_ledger_entry_id FOR UPDATE;
      IF NOT FOUND OR original_creator.amount IS DISTINCT FROM initial_creator_amount
         OR original_creator.user_id IS DISTINCT FROM NEW.creator_user_id
         OR original_creator.entry_type IS DISTINCT FROM 'earning'
         OR original_creator.earnings_source IS DISTINCT FROM 'miniapp'
         OR original_creator.metadata->>'chargeTransactionId' IS DISTINCT FROM NEW.reservation_transaction_id::text
         OR original_creator.metadata->>'app_id' IS DISTINCT FROM NEW.app_id::text
         OR original_creator.metadata->>'transaction_user_id' IS DISTINCT FROM NEW.user_id::text
         OR original_creator.metadata->>'earnings_type' IS DISTINCT FROM 'inference_markup'
         OR original_creator.metadata->>'original_source_id' IS DISTINCT FROM
              'app-charge:' || NEW.reservation_transaction_id::text || ':inference_markup:deduct'
         OR (SELECT count(*) FROM redeemable_earnings_ledger
              WHERE metadata->>'chargeTransactionId' = NEW.reservation_transaction_id::text) <> 1 THEN
        RAISE EXCEPTION 'app creator original earning identity does not match reservation'
          USING ERRCODE = '23514', CONSTRAINT = 'app_reservation_creator_original_match';
      END IF;
    END IF;
    creator_expected_movement := final_creator_amount - initial_creator_amount;
  END IF;

  IF NEW.redeemable_ledger_entry_id IS NOT NULL THEN
    SELECT amount, user_id, earnings_source
      INTO creator_ledger_amount, creator_ledger_user, creator_ledger_source
    FROM redeemable_earnings_ledger
    WHERE id = NEW.redeemable_ledger_entry_id;
  END IF;
  IF NEW.outcome IN ('refund', 'overage') AND creator_expected_movement <> 0 THEN
    IF NEW.redeemable_ledger_entry_id IS NULL
       OR creator_ledger_user IS DISTINCT FROM NEW.creator_user_id
       OR creator_ledger_source <> 'miniapp'
       OR creator_ledger_amount IS DISTINCT FROM creator_expected_movement THEN
      RAISE EXCEPTION 'app reservation creator ledger does not match receipt'
        USING ERRCODE = '23514',
              CONSTRAINT = 'app_reservation_settlements_creator_match';
    END IF;
  ELSIF NEW.redeemable_ledger_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'app reservation receipt has an unexpected creator ledger'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlements_creator_match';
  END IF;

  IF NEW.app_earnings_transaction_id IS NOT NULL THEN
    SELECT app_id, user_id, amount, metadata->>'redeemableLedgerEntryId'
      INTO app_projection_app, app_projection_user, app_projection_amount, app_projection_ledger
    FROM app_earnings_transactions
    WHERE id = NEW.app_earnings_transaction_id;
    IF app_projection_app IS DISTINCT FROM NEW.app_id
       OR app_projection_user IS DISTINCT FROM NEW.user_id
       OR app_projection_amount IS DISTINCT FROM creator_expected_movement
       OR app_projection_ledger IS DISTINCT FROM NEW.redeemable_ledger_entry_id::text THEN
      RAISE EXCEPTION 'app reservation app projection does not match receipt'
        USING ERRCODE = '23514',
              CONSTRAINT = 'app_reservation_settlements_app_projection_match';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_reservation_creator_projection() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM app_reservation_settlements
       WHERE redeemable_ledger_entry_id = OLD.id OR creator_original_ledger_entry_id = OLD.id
     )
     AND (NEW.id IS DISTINCT FROM OLD.id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.earnings_source IS DISTINCT FROM OLD.earnings_source
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.entry_type IS DISTINCT FROM OLD.entry_type
       OR NEW.metadata IS DISTINCT FROM OLD.metadata) THEN
    RAISE EXCEPTION 'referenced app reservation creator projection is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'redeemable_earnings_app_settlement_projection_immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_reservation_creator_projection_delete() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() <= 1
     AND EXISTS (
       SELECT 1 FROM app_reservation_settlements
       WHERE redeemable_ledger_entry_id = OLD.id OR creator_original_ledger_entry_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'referenced app reservation creator projection cannot be deleted directly'
      USING ERRCODE = '23514', CONSTRAINT = 'redeemable_earnings_app_settlement_projection_delete';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_app_reservation_creator_projection_truncate() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app_reservation_settlements WHERE redeemable_ledger_entry_id IS NOT NULL OR creator_original_ledger_entry_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'referenced app reservation creator projections cannot be truncated'
      USING ERRCODE = '23514', CONSTRAINT = 'redeemable_earnings_app_settlement_projection_truncate';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
